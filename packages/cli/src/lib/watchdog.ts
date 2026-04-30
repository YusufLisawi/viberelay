/**
 * RelayMind watchdog — long-running health-check loop + daily summary scheduler.
 *
 * Responsibilities:
 *   - Every `healthCheckIntervalMs` (default 30 000) call supervisor.runHealthCheck.
 *   - Once per minute check whether the configured `dailySummaryAt` (HH:MM local)
 *     has been crossed and no summary file exists for today; if so, invoke
 *     `daily summarize` deterministically (no LLM).
 *   - Write pid and log to <supervisorStateDir>/watchdog.pid|.log.
 *   - Persist last-fired-summary-day in <supervisorStateDir>/watchdog.state.json
 *     via atomic write so it survives crashes.
 *   - Honor AbortSignal for clean shutdown.
 *
 * Hard rules: Node stdlib only, no `any`, Bun runtime, NodeNext ESM.
 */

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import type { RelayMindPaths } from '@viberelay/shared/relaymind'
import { runHealthCheck } from './supervisor.js'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_HEALTH_INTERVAL_MS = 30_000
const DEFAULT_DAILY_SUMMARY_AT = '22:00'
/** Summary-due check runs every minute within the health-check loop. */
const SUMMARY_CHECK_INTERVAL_MS = 60_000
/** Grace period when waiting for the watchdog process to die before SIGKILL. */
const STOP_GRACE_MS = 5_000
const POLL_INTERVAL_MS = 100

// ─── File path helpers ───────────────────────────────────────────────────────

function watchdogPidFile(paths: RelayMindPaths): string {
  return join(paths.supervisorStateDir, 'watchdog.pid')
}

function watchdogLogFile(paths: RelayMindPaths): string {
  return join(paths.supervisorStateDir, 'watchdog.log')
}

function watchdogStateFile(paths: RelayMindPaths): string {
  return join(paths.supervisorStateDir, 'watchdog.state.json')
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function appendLog(paths: RelayMindPaths, line: string): Promise<void> {
  await mkdir(paths.supervisorStateDir, { recursive: true })
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  await appendFile(watchdogLogFile(paths), stamped, 'utf8')
}

async function atomicWrite(target: string, data: string): Promise<void> {
  await mkdir(join(target, '..'), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, target)
}

async function readPidFile(file: string): Promise<number | null> {
  try {
    const raw = await readFile(file, 'utf8')
    const n = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

interface WatchdogState {
  /** YYYY-MM-DD local date for which the daily summary was last fired. */
  lastFiredDay: string | null
  /** ISO timestamp of the last successful health check. */
  lastHealthCheckAt: string | null
}

async function readState(paths: RelayMindPaths): Promise<WatchdogState> {
  try {
    const raw = await readFile(watchdogStateFile(paths), 'utf8')
    return JSON.parse(raw) as WatchdogState
  } catch {
    return { lastFiredDay: null, lastHealthCheckAt: null }
  }
}

async function writeState(paths: RelayMindPaths, state: WatchdogState): Promise<void> {
  await atomicWrite(watchdogStateFile(paths), JSON.stringify(state, null, 2))
}

// ─── Time-window logic ────────────────────────────────────────────────────────
//
// "dailySummaryAt" is HH:MM in local time. The watchdog fires the summary when:
//   1. The current local time is >= HH:MM today, AND
//   2. No summary file exists for today (paths.dailyDir/YYYY-MM-DD.md), AND
//   3. We have not already fired the summary for today (lastFiredDay != today).
//
// Day key is always local YYYY-MM-DD so the user's timezone governs the cutoff.

function localDateKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Returns true when the clock has crossed the HH:MM threshold for today
 * and the local date key is `todayKey`.
 */
function hasCrossedDailySummaryAt(now: Date, dailySummaryAt: string): boolean {
  const [hStr, mStr] = dailySummaryAt.split(':')
  const targetH = Number.parseInt(hStr ?? '22', 10)
  const targetM = Number.parseInt(mStr ?? '0', 10)
  const currentH = now.getHours()
  const currentM = now.getMinutes()
  if (currentH > targetH) return true
  if (currentH === targetH && currentM >= targetM) return true
  return false
}

async function dailySummaryFileExists(paths: RelayMindPaths, dayKey: string): Promise<boolean> {
  const filePath = join(paths.dailyDir, `${dayKey}.md`)
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

// ─── Summary trigger ──────────────────────────────────────────────────────────

async function fireDailySummary(paths: RelayMindPaths, dayKey: string): Promise<void> {
  // Import daily.ts default export and call it programmatically.
  // We pass ['summarize', '--date', dayKey] so the correct date is always used.
  const { default: dailyCommand } = (await import(
    '../commands/relaymind/daily.js'
  )) as { default: (argv: string[], baseUrl: string) => Promise<string> }
  const result = await dailyCommand(['summarize', '--date', dayKey], '')
  await appendLog(paths, `daily-summary fired day=${dayKey} result=${result}`)
}

// ─── Tick (single health-check + summary-due check) ──────────────────────────

export interface TickOptions {
  /** HH:MM local time, default '22:00'. */
  dailySummaryAt?: string
  /** Injected for tests — allows controlling "now". */
  now?: () => Date
  /** Injected for tests — skip actual CLI invocation. */
  fireSummary?: (paths: RelayMindPaths, dayKey: string) => Promise<void>
}

export interface TickResult {
  healthStatus: string
  summarized: boolean
  summarySkippedReason?: string
}

/**
 * Runs one health-check cycle and one summary-due check.
 * Used by the loop and exposed directly for tests via `watchdog tick`.
 */
export async function tick(paths: RelayMindPaths, opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ? opts.now() : new Date()
  const dailySummaryAt = opts.dailySummaryAt ?? DEFAULT_DAILY_SUMMARY_AT
  const doFire = opts.fireSummary ?? fireDailySummary

  // 1. Health check.
  const health = await runHealthCheck(paths)
  await appendLog(paths, `tick health=${health.status}`)

  // 2. Read persistent state.
  const state = await readState(paths)
  state.lastHealthCheckAt = health.checkedAt

  // 3. Summary-due check.
  const todayKey = localDateKey(now)
  let summarized = false
  let summarySkippedReason: string | undefined

  if (!hasCrossedDailySummaryAt(now, dailySummaryAt)) {
    summarySkippedReason = `dailySummaryAt ${dailySummaryAt} not yet reached`
  } else if (state.lastFiredDay === todayKey) {
    summarySkippedReason = `already fired for ${todayKey}`
  } else if (await dailySummaryFileExists(paths, todayKey)) {
    // File exists (e.g. written via Claude --from-stdin path). Record as fired.
    state.lastFiredDay = todayKey
    summarySkippedReason = `summary file already exists for ${todayKey}`
  } else {
    // Fire.
    await doFire(paths, todayKey)
    state.lastFiredDay = todayKey
    summarized = true
  }

  await writeState(paths, state)

  return { healthStatus: health.status, summarized, summarySkippedReason }
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

export interface WatchdogOpts {
  /** Milliseconds between health checks. Default 30 000. */
  healthCheckIntervalMs?: number
  /** HH:MM local time for daily summary. Default '22:00'. */
  dailySummaryAt?: string
  /** AbortSignal for clean shutdown. */
  signal?: AbortSignal
  /** How often (in ticks) to also run a summary-due check. Default: every 2 ticks (~1 min). */
  summaryCheckEveryTicks?: number
}

/**
 * Long-running watchdog loop.
 * Blocks until `signal` is aborted or the process is killed.
 */
export async function runWatchdogLoop(paths: RelayMindPaths, opts: WatchdogOpts = {}): Promise<void> {
  const intervalMs = opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
  const dailySummaryAt = opts.dailySummaryAt ?? DEFAULT_DAILY_SUMMARY_AT
  const signal = opts.signal
  // Run summary check every summaryCheckEveryTicks ticks (default so that
  // checks happen roughly every 60s at the default 30s interval).
  const summaryEvery = opts.summaryCheckEveryTicks ?? Math.max(1, Math.round(SUMMARY_CHECK_INTERVAL_MS / intervalMs))

  await appendLog(paths, `watchdog started pid=${process.pid} interval=${intervalMs}ms dailySummaryAt=${dailySummaryAt}`)

  let tickCount = 0

  while (!signal?.aborted) {
    // Sleep first (with early abort) so we don't hammer on startup.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs)
      if (signal) {
        const onAbort = () => {
          clearTimeout(t)
          resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })

    if (signal?.aborted) break

    tickCount++
    const runSummaryCheck = tickCount % summaryEvery === 0

    try {
      await tick(paths, {
        dailySummaryAt,
        // Only run summary-due check every summaryEvery ticks.
        // We use a "now in the past" trick: if it's not a summary tick, pass a
        // time that will never cross the threshold.
        ...(runSummaryCheck ? {} : { now: () => new Date(0) }),
      })
    } catch (err) {
      await appendLog(paths, `tick-error ${(err as Error).message}`)
    }
  }

  await appendLog(paths, `watchdog stopped pid=${process.pid}`)
}

// ─── startWatchdog ────────────────────────────────────────────────────────────

export interface StartWatchdogOptions {
  healthCheckIntervalMs?: number
  dailySummaryAt?: string
  /** Run in the current process (blocking). */
  foreground?: boolean
  signal?: AbortSignal
}

/**
 * Start the watchdog.
 *
 * - Without `foreground`: spawns `process.execPath` with the current argv[1]
 *   entry point plus `relaymind watchdog start --foreground`, detached + unref'd,
 *   writes pid file.
 * - With `foreground`: runs the loop in-process (blocking).
 */
export async function startWatchdog(
  paths: RelayMindPaths,
  opts: StartWatchdogOptions = {},
): Promise<void> {
  await mkdir(paths.supervisorStateDir, { recursive: true })

  if (opts.foreground) {
    // Write our own pid file.
    await atomicWrite(watchdogPidFile(paths), `${process.pid}\n`)
    await appendLog(paths, `watchdog foreground started pid=${process.pid}`)

    const ac = new AbortController()
    const signal = opts.signal ?? ac.signal

    // Graceful SIGINT/SIGTERM: stop the loop and clean up.
    const cleanup = async () => {
      ac.abort()
      await rm(watchdogPidFile(paths), { force: true })
    }
    process.once('SIGINT', () => { void cleanup() })
    process.once('SIGTERM', () => { void cleanup() })

    try {
      await runWatchdogLoop(paths, {
        healthCheckIntervalMs: opts.healthCheckIntervalMs,
        dailySummaryAt: opts.dailySummaryAt,
        signal,
      })
    } finally {
      await rm(watchdogPidFile(paths), { force: true })
    }
    return
  }

  // Background mode: spawn self with --foreground.
  const { spawn } = await import('node:child_process')
  // Reconstruct the CLI entry point from process.argv[1].
  const entry = process.argv[1] ?? 'viberelay'
  const args: string[] = [entry, 'relaymind', 'watchdog', 'start', '--foreground']
  if (opts.healthCheckIntervalMs !== undefined) {
    args.push('--interval', String(opts.healthCheckIntervalMs))
  }
  if (opts.dailySummaryAt !== undefined) {
    args.push('--daily-summary-at', opts.dailySummaryAt)
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })

  if (typeof child.pid !== 'number') {
    throw new Error('watchdog: failed to spawn background process (no pid)')
  }

  child.unref()

  await atomicWrite(watchdogPidFile(paths), `${child.pid}\n`)
  await appendLog(paths, `watchdog background started pid=${child.pid}`)
}

// ─── stopWatchdog ─────────────────────────────────────────────────────────────

/**
 * Read the watchdog pid file, SIGTERM, wait up to 5 s, then SIGKILL.
 */
export async function stopWatchdog(paths: RelayMindPaths): Promise<{ stopped: boolean; pid: number | null }> {
  const pid = await readPidFile(watchdogPidFile(paths))

  if (pid === null) {
    await appendLog(paths, 'watchdog stop noop=no-pid')
    return { stopped: false, pid: null }
  }

  if (!isAlive(pid)) {
    await rm(watchdogPidFile(paths), { force: true })
    await appendLog(paths, `watchdog stop noop=stale-pid pid=${pid}`)
    return { stopped: false, pid }
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    await appendLog(paths, `watchdog stop sigterm-failed pid=${pid} err=${(err as Error).message}`)
  }

  const deadline = Date.now() + STOP_GRACE_MS
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone between checks */
    }
    await appendLog(paths, `watchdog stop sigkill pid=${pid}`)
  } else {
    await appendLog(paths, `watchdog stop sigterm-ok pid=${pid}`)
  }

  await rm(watchdogPidFile(paths), { force: true })
  return { stopped: true, pid }
}

// ─── getWatchdogStatus ────────────────────────────────────────────────────────

export interface WatchdogStatus {
  running: boolean
  pid: number | null
  lastHealthCheckAt: string | null
  /** ISO timestamp of when the next daily summary is expected to fire. */
  nextDailySummaryEta: string | null
}

/**
 * Returns current watchdog status: pid alive?, last health check, next summary ETA.
 */
export async function getWatchdogStatus(paths: RelayMindPaths, opts: { dailySummaryAt?: string } = {}): Promise<WatchdogStatus> {
  const pid = await readPidFile(watchdogPidFile(paths))
  const running = pid !== null && isAlive(pid)
  const state = await readState(paths)

  const dailySummaryAt = opts.dailySummaryAt ?? DEFAULT_DAILY_SUMMARY_AT
  const nextDailySummaryEta = computeNextEta(dailySummaryAt, state.lastFiredDay)

  return {
    running,
    pid: running ? pid : null,
    lastHealthCheckAt: state.lastHealthCheckAt,
    nextDailySummaryEta,
  }
}

/**
 * Computes the next ISO timestamp at which the daily summary will fire.
 *
 * - If lastFiredDay is today, the next fire is tomorrow at dailySummaryAt.
 * - If dailySummaryAt is in the future today, that's the next fire.
 * - If dailySummaryAt has passed today and nothing fired, it fires soon (return now).
 */
function computeNextEta(dailySummaryAt: string, lastFiredDay: string | null): string | null {
  const [hStr, mStr] = dailySummaryAt.split(':')
  const targetH = Number.parseInt(hStr ?? '22', 10)
  const targetM = Number.parseInt(mStr ?? '0', 10)

  if (Number.isNaN(targetH) || Number.isNaN(targetM)) return null

  const now = new Date()
  const todayKey = localDateKey(now)

  // Build a Date for today at dailySummaryAt local time.
  const todayFire = new Date(now)
  todayFire.setHours(targetH, targetM, 0, 0)

  if (lastFiredDay === todayKey) {
    // Already fired today — next is tomorrow.
    const tomorrowFire = new Date(todayFire)
    tomorrowFire.setDate(tomorrowFire.getDate() + 1)
    return tomorrowFire.toISOString()
  }

  if (now < todayFire) {
    // Threshold is in the future today.
    return todayFire.toISOString()
  }

  // Threshold has passed but not yet fired — overdue, fires on next tick.
  return now.toISOString()
}
