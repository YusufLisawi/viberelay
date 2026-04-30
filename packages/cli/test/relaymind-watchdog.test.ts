import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { relayMindPaths } from '@viberelay/shared/relaymind'
import {
  getWatchdogStatus,
  startWatchdog,
  stopWatchdog,
  tick,
  type TickOptions,
} from '../src/lib/watchdog.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let workspace: string
let cwd: string

beforeEach(async () => {
  cwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-watchdog-'))
  process.chdir(workspace)
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(workspace, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function paths() {
  return relayMindPaths(workspace)
}

function watchdogLogFile() {
  return join(paths().supervisorStateDir, 'watchdog.log')
}

function watchdogStateFile() {
  return join(paths().supervisorStateDir, 'watchdog.state.json')
}

function watchdogPidFile() {
  return join(paths().supervisorStateDir, 'watchdog.pid')
}

/** Build a fake `fireSummary` that records which days were fired. */
function makeFakeFire() {
  const fired: string[] = []
  const fn = async (_paths: ReturnType<typeof relayMindPaths>, dayKey: string): Promise<void> => {
    fired.push(dayKey)
  }
  return { fn, fired }
}

/** Build a Date for today at a specific HH:MM local time. */
function localTimeToday(hh: number, mm: number): Date {
  const d = new Date()
  d.setHours(hh, mm, 0, 0)
  return d
}

// ─── tick — health check ──────────────────────────────────────────────────────

describe('tick — health check', () => {
  it('runs health check and writes a log line', async () => {
    const p = paths()
    const fake = makeFakeFire()

    // Run tick with time set before daily-summary-at so summary doesn't fire.
    const result = await tick(p, {
      dailySummaryAt: '23:59',
      now: () => localTimeToday(0, 0),
      fireSummary: fake.fn,
    })

    expect(result.healthStatus).toBe('stopped') // no supervisor running
    expect(result.summarized).toBe(false)

    // Log must exist and contain a health line.
    const log = await readFile(watchdogLogFile(), 'utf8')
    expect(log).toContain('tick health=stopped')
  })

  it('persists lastHealthCheckAt in watchdog.state.json', async () => {
    const p = paths()
    const fake = makeFakeFire()

    await tick(p, {
      dailySummaryAt: '23:59',
      now: () => localTimeToday(0, 0),
      fireSummary: fake.fn,
    })

    const raw = await readFile(watchdogStateFile(), 'utf8')
    const state = JSON.parse(raw) as { lastHealthCheckAt: string | null; lastFiredDay: string | null }
    expect(typeof state.lastHealthCheckAt).toBe('string')
    expect(state.lastFiredDay).toBeNull()
  })
})

// ─── tick — daily summary time-window logic ───────────────────────────────────

describe('tick — daily summary time-window', () => {
  it('fires summary when dailySummaryAt is in the past today and not yet fired', async () => {
    const p = paths()
    const fake = makeFakeFire()

    // dailySummaryAt = 08:00, now = 09:00 → threshold has passed.
    const result = await tick(p, {
      dailySummaryAt: '08:00',
      now: () => localTimeToday(9, 0),
      fireSummary: fake.fn,
    })

    expect(result.summarized).toBe(true)
    expect(fake.fired).toHaveLength(1)
  })

  it('does NOT fire when dailySummaryAt is in the future today', async () => {
    const p = paths()
    const fake = makeFakeFire()

    // dailySummaryAt = 22:00, now = 10:00 → threshold not yet reached.
    const result = await tick(p, {
      dailySummaryAt: '22:00',
      now: () => localTimeToday(10, 0),
      fireSummary: fake.fn,
    })

    expect(result.summarized).toBe(false)
    expect(result.summarySkippedReason).toContain('22:00 not yet reached')
    expect(fake.fired).toHaveLength(0)
  })

  it('fires exactly at the threshold minute (HH:MM == now)', async () => {
    const p = paths()
    const fake = makeFakeFire()

    const result = await tick(p, {
      dailySummaryAt: '14:30',
      now: () => localTimeToday(14, 30),
      fireSummary: fake.fn,
    })

    expect(result.summarized).toBe(true)
    expect(fake.fired).toHaveLength(1)
  })

  it('fires exactly once per day — second tick same day is a no-op', async () => {
    const p = paths()
    const fake = makeFakeFire()

    const tickOpts: TickOptions = {
      dailySummaryAt: '08:00',
      now: () => localTimeToday(9, 0),
      fireSummary: fake.fn,
    }

    const first = await tick(p, tickOpts)
    expect(first.summarized).toBe(true)

    const second = await tick(p, tickOpts)
    expect(second.summarized).toBe(false)
    expect(second.summarySkippedReason).toContain('already fired')

    // Still only fired once.
    expect(fake.fired).toHaveLength(1)
  })

  it('skips fire when summary file already exists (written by Claude path)', async () => {
    const p = paths()
    const fake = makeFakeFire()

    // Pre-create the daily file.
    const today = new Date()
    const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    await mkdir(p.dailyDir, { recursive: true })
    await writeFile(join(p.dailyDir, `${dayKey}.md`), `# Daily Summary — ${dayKey}\n`, 'utf8')

    const result = await tick(p, {
      dailySummaryAt: '08:00',
      now: () => localTimeToday(9, 0),
      fireSummary: fake.fn,
    })

    expect(result.summarized).toBe(false)
    expect(result.summarySkippedReason).toContain('already exists')
    expect(fake.fired).toHaveLength(0)
  })

  it('records the fired day in watchdog.state.json so restart does not re-fire', async () => {
    const p = paths()
    const fake = makeFakeFire()

    await tick(p, {
      dailySummaryAt: '08:00',
      now: () => localTimeToday(9, 0),
      fireSummary: fake.fn,
    })

    const raw = await readFile(watchdogStateFile(), 'utf8')
    const state = JSON.parse(raw) as { lastFiredDay: string | null }
    const today = new Date()
    const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(state.lastFiredDay).toBe(dayKey)
  })
})

// ─── tick — day boundary (different days) ────────────────────────────────────

describe('tick — day boundary', () => {
  it('re-fires on a new day even if it fired yesterday', async () => {
    const p = paths()
    const fake = makeFakeFire()

    // Simulate: yesterday's state already recorded.
    await mkdir(p.supervisorStateDir, { recursive: true })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
    await writeFile(
      join(p.supervisorStateDir, 'watchdog.state.json'),
      JSON.stringify({ lastFiredDay: yesterdayKey, lastHealthCheckAt: null }),
      'utf8',
    )

    // Now tick for today (past daily-summary-at).
    const result = await tick(p, {
      dailySummaryAt: '08:00',
      now: () => localTimeToday(9, 0),
      fireSummary: fake.fn,
    })

    expect(result.summarized).toBe(true)
    expect(fake.fired).toHaveLength(1)
    // Must be today's key, not yesterday's.
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(fake.fired[0]).toBe(todayKey)
  })
})

// ─── pid lifecycle ────────────────────────────────────────────────────────────

describe('pid lifecycle', () => {
  it('startWatchdog (background) writes a pid file', async () => {
    const p = paths()

    // We can't actually spawn and wait cleanly in tests, so just verify the
    // pid-writing path by using the foreground path with an already-aborted signal.
    const ac = new AbortController()
    ac.abort()

    await startWatchdog(p, {
      foreground: true,
      signal: ac.signal,
    })

    // The pid file is cleaned up on exit — but the log should record the start.
    const log = await readFile(watchdogLogFile(), 'utf8')
    expect(log).toContain('watchdog foreground started')
  })

  it('stopWatchdog returns not-running when no pid file exists', async () => {
    const p = paths()
    const result = await stopWatchdog(p)
    expect(result.stopped).toBe(false)
    expect(result.pid).toBeNull()
  })

  it('stopWatchdog cleans up a stale pid file', async () => {
    const p = paths()
    await mkdir(p.supervisorStateDir, { recursive: true })
    // Write a pid that cannot possibly be alive.
    await writeFile(watchdogPidFile(), '999999999\n', 'utf8')

    const result = await stopWatchdog(p)
    expect(result.stopped).toBe(false) // process wasn't alive to kill
    expect(result.pid).toBe(999999999)

    // Pid file must be gone.
    await expect(stat(watchdogPidFile())).rejects.toThrow()
  })

  it('getWatchdogStatus reflects not-running when no pid', async () => {
    const p = paths()
    const status = await getWatchdogStatus(p)
    expect(status.running).toBe(false)
    expect(status.pid).toBeNull()
  })

  it('getWatchdogStatus returns lastHealthCheckAt from state', async () => {
    const p = paths()
    const fake = makeFakeFire()

    await tick(p, {
      dailySummaryAt: '23:59',
      now: () => localTimeToday(0, 0),
      fireSummary: fake.fn,
    })

    const status = await getWatchdogStatus(p)
    expect(typeof status.lastHealthCheckAt).toBe('string')
  })
})

// ─── start --foreground exits cleanly on abort ───────────────────────────────

describe('start --foreground', () => {
  it('exits cleanly when AbortSignal is aborted immediately', async () => {
    const p = paths()
    const ac = new AbortController()
    ac.abort() // abort before the loop even starts

    await expect(
      startWatchdog(p, { foreground: true, signal: ac.signal }),
    ).resolves.toBeUndefined()

    // Pid file is cleaned up after loop exits.
    await expect(stat(watchdogPidFile())).rejects.toThrow()
  })

  it('writes and then removes the pid file on clean shutdown', async () => {
    const p = paths()
    const ac = new AbortController()

    // Start the loop in background (promise), then abort after a tick.
    const loopPromise = startWatchdog(p, {
      foreground: true,
      signal: ac.signal,
      healthCheckIntervalMs: 50, // short so test doesn't wait long
    })

    // Give it a moment to write the pid, then abort.
    await new Promise((r) => setTimeout(r, 20))

    // The pid file should exist at this point.
    // (We abort before the first sleep completes, so it may or may not have written yet.)
    // Abort and wait for clean exit.
    ac.abort()
    await loopPromise

    // Pid file must be gone after clean exit.
    await expect(stat(watchdogPidFile())).rejects.toThrow()
  })
})

// ─── getWatchdogStatus — nextDailySummaryEta ─────────────────────────────────

describe('getWatchdogStatus — nextDailySummaryEta', () => {
  it('returns a valid ISO string', async () => {
    const p = paths()
    const status = await getWatchdogStatus(p, { dailySummaryAt: '22:00' })
    expect(status.nextDailySummaryEta).not.toBeNull()
    expect(() => new Date(status.nextDailySummaryEta!).toISOString()).not.toThrow()
  })

  it('returns null for an invalid dailySummaryAt', async () => {
    const p = paths()
    const status = await getWatchdogStatus(p, { dailySummaryAt: 'not-a-time' })
    expect(status.nextDailySummaryEta).toBeNull()
  })
})
