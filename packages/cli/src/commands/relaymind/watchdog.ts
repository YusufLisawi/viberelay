/**
 * `viberelay relaymind watchdog <subcommand>` — watchdog process management.
 *
 * Subcommands:
 *   start [--foreground]              Without --foreground: spawn self detached
 *                                     and return. With --foreground: run the loop
 *                                     in the current process (blocking).
 *   stop                              SIGTERM the watchdog, wait, SIGKILL if needed.
 *   status                            Print a 3-line status summary.
 *   tick (hidden, for tests)          Run one health-check + summary-due check.
 *
 * No LLM calls. All logic is deterministic.
 */
import process from 'node:process'

import { relayMindPaths } from '@viberelay/shared/relaymind'
import {
  getWatchdogStatus,
  startWatchdog,
  stopWatchdog,
  tick,
} from '../../lib/watchdog.js'

// ── helpers ───────────────────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const key = a.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function flagStr(flags: ParsedArgs['flags'], key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function flagBool(flags: ParsedArgs['flags'], key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

// ── subcommands ───────────────────────────────────────────────────────────────

async function cmdStart(args: ParsedArgs): Promise<string> {
  const foreground = flagBool(args.flags, 'foreground')
  const paths = relayMindPaths(process.cwd())

  const intervalMs = (() => {
    const v = flagStr(args.flags, 'interval')
    if (v === undefined) return undefined
    const n = Number.parseInt(v, 10)
    if (!Number.isFinite(n) || n <= 0) throw new Error('--interval must be a positive integer (ms)')
    return n
  })()

  const dailySummaryAt = flagStr(args.flags, 'daily-summary-at')

  if (foreground) {
    // Blocking — this call only returns when the loop exits (signal/abort).
    await startWatchdog(paths, {
      foreground: true,
      healthCheckIntervalMs: intervalMs,
      dailySummaryAt,
    })
    return 'watchdog stopped'
  }

  await startWatchdog(paths, {
    foreground: false,
    healthCheckIntervalMs: intervalMs,
    dailySummaryAt,
  })

  const status = await getWatchdogStatus(paths)
  return `watchdog started (background) pid=${status.pid ?? 'unknown'}`
}

async function cmdStop(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const result = await stopWatchdog(paths)
  if (!result.stopped && result.pid === null) return 'watchdog not running'
  if (!result.stopped) return `watchdog pid=${result.pid} was already dead (cleaned up)`
  return `watchdog stopped pid=${result.pid}`
}

async function cmdStatus(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const status = await getWatchdogStatus(paths)

  const line1 = `running:          ${status.running ? `yes (pid=${status.pid})` : 'no'}`
  const line2 = `last health check: ${status.lastHealthCheckAt ?? 'never'}`
  const line3 = `next daily summary: ${status.nextDailySummaryEta ?? 'unknown'}`

  return [line1, line2, line3].join('\n')
}

async function cmdTick(args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const dailySummaryAt = flagStr(args.flags, 'daily-summary-at')

  const result = await tick(paths, { dailySummaryAt })

  const parts = [
    `health=${result.healthStatus}`,
    `summarized=${result.summarized}`,
  ]
  if (result.summarySkippedReason) {
    parts.push(`skipped=${result.summarySkippedReason}`)
  }
  return parts.join(' ')
}

// ── entry ─────────────────────────────────────────────────────────────────────

const HELP = `viberelay relaymind watchdog <subcommand>

  start [--foreground]          Start the watchdog process.
                                Without --foreground: spawn detached and return.
                                With --foreground: run loop in current process.
        [--interval <ms>]       Override health-check interval (default 30000).
        [--daily-summary-at HH:MM]
                                Override daily summary time (default 22:00 local).
  stop                          Stop the running watchdog.
  status                        Show watchdog status (3 lines).`

const HANDLERS: Record<string, (args: ParsedArgs) => Promise<string>> = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  tick: cmdTick,  // hidden — used by tests
}

export default async function watchdogCommand(argv: string[], _baseUrl: string): Promise<string> {
  void _baseUrl
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return HELP
  const handler = HANDLERS[sub]
  if (!handler) throw new Error(`unknown watchdog subcommand: ${sub}\n\n${HELP}`)
  return handler(parseArgs(argv.slice(1)))
}
