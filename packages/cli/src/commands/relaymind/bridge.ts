/**
 * `viberelay relaymind bridge <subcommand>` — Telegram bridge worker.
 *
 * The bridge is a side-channel for inbound Telegram messages while
 * Anthropic issue #36503 (the `tengu_harbor` channel gate) silently drops
 * `notifications/claude/channel`. It polls a file mirror written by the
 * telegram plugin, runs `claude --print --resume` per message, and replies
 * via the Bot HTTP API.
 *
 * Subcommands:
 *   start [--foreground] [--interval <ms>]
 *   stop
 *   status
 *   tick                              (single-step, used for tests)
 */
import process from 'node:process'

import { relayMindPaths } from '@viberelay/shared/relaymind'
import {
  getBridgeStatus,
  startBridge,
  stopBridge,
  tickBridge,
} from '../../lib/telegram-bridge.js'

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

  if (foreground) {
    await startBridge(paths, { foreground: true, pollIntervalMs: intervalMs })
    return 'bridge stopped'
  }

  await startBridge(paths, { foreground: false, pollIntervalMs: intervalMs })
  const status = await getBridgeStatus(paths)
  return `bridge started (background) pid=${status.pid ?? 'unknown'}`
}

async function cmdStop(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const r = await stopBridge(paths)
  if (!r.stopped && r.pid === null) return 'bridge not running'
  if (!r.stopped) return `bridge pid=${r.pid} was already dead (cleaned up)`
  return `bridge stopped pid=${r.pid}`
}

async function cmdStatus(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const s = await getBridgeStatus(paths)
  return [
    `running:           ${s.running ? `yes (pid=${s.pid})` : 'no'}`,
    `pending:           ${s.pendingCount}${s.nextPendingFile ? ` next=${s.nextPendingFile}` : ''}`,
    `processed:         ${s.processedCount}`,
    `failed:            ${s.failedCount}`,
    `last processed at: ${s.lastProcessedAt ?? 'never'}`,
    `last error:        ${s.lastError ?? 'none'}`,
  ].join('\n')
}

async function cmdTick(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const r = await tickBridge(paths)
  if (r.status === 'idle') return 'bridge tick: idle (no pending messages)'
  if (r.status === 'misconfigured') return `bridge tick: misconfigured — ${r.reason}`
  if (r.status === 'processed') return `bridge tick: processed file=${r.file}`
  return `bridge tick: failed file=${r.file} reason=${r.reason}`
}

const HELP = `viberelay relaymind bridge <subcommand>

  start [--foreground]      Start the bridge process.
                            Without --foreground: spawn detached and return.
                            With --foreground: run loop in current process.
        [--interval <ms>]   Override poll interval (default 1500ms).
  stop                      Stop the running bridge.
  status                    Show bridge status (running, pending, counters).
  tick                      Process exactly one queued message (for debugging).

Why this exists: Claude Code's tengu_harbor flag (issue #36503) silently
blocks notifications/claude/channel from reaching the conversation. The
bridge polls <telegramStateDir>/messages/ for files mirrored by the
plugin and replies via the Bot HTTP API.`

const HANDLERS: Record<string, (args: ParsedArgs) => Promise<string>> = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  tick: cmdTick,
}

export default async function bridgeCommand(argv: string[], _baseUrl: string): Promise<string> {
  void _baseUrl
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return HELP
  const handler = HANDLERS[sub]
  if (!handler) throw new Error(`unknown bridge subcommand: ${sub}\n\n${HELP}`)
  return handler(parseArgs(argv.slice(1)))
}
