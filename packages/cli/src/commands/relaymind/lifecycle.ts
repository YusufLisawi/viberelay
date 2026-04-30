/**
 * `viberelay relaymind {start,stop,restart,status,logs,attach,send}` —
 * lifecycle router.
 *
 * The registrar (./index.ts) dynamically loads `./<verb>.ts`, each of which
 * is a thin shim that calls back into this module. Centralizing the routing
 * keeps argv parsing and output formatting in one place — the verb shims
 * exist only so the registrar's filename-based dispatch keeps working.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

import { relayMindPaths } from '@viberelay/shared/relaymind'
import {
  attachSession,
  capturePane,
  getStatus,
  restartSession,
  sendKeys,
  startSession,
  stopSession,
  tailLogs,
} from '../../lib/supervisor.js'

type Verb = 'start' | 'stop' | 'restart' | 'status' | 'logs' | 'attach' | 'send'

const VERBS: ReadonlySet<Verb> = new Set([
  'start',
  'stop',
  'restart',
  'status',
  'logs',
  'attach',
  'send',
])

function isVerb(s: string | undefined): s is Verb {
  return typeof s === 'string' && (VERBS as ReadonlySet<string>).has(s)
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

function parseLogN(argv: readonly string[]): number {
  // First positional integer; default 50.
  for (const a of argv) {
    if (a.startsWith('--')) continue
    const n = Number.parseInt(a, 10)
    if (Number.isInteger(n) && n > 0) return n
  }
  return 50
}

const VERB_HELP: Record<Verb, string> = {
  start: `viberelay relaymind start

  Start the persistent Claude Code session under supervisor control.
  The session runs inside a tmux session named after \`config.json\`'s
  \`sessionName\` (default \`relaymind-main\`). Requires \`tmux\` on PATH.

Usage:
  viberelay relaymind start            Start a new session
  viberelay relaymind start --resume   Resume the previous session

Examples:
  viberelay relaymind start
  viberelay relaymind start --resume`,

  stop: `viberelay relaymind stop

  Stop the currently running Claude Code session. Sends Ctrl-C to the
  tmux pane (so Claude can flush) before killing the tmux session.

Usage:
  viberelay relaymind stop   Send stop signal to the supervisor

Examples:
  viberelay relaymind stop`,

  restart: `viberelay relaymind restart

  Restart the Claude Code session (stop + start --resume).

Usage:
  viberelay relaymind restart                  Full restart
  viberelay relaymind restart --plugin-only    Reload plugin without full restart

Examples:
  viberelay relaymind restart
  viberelay relaymind restart --plugin-only`,

  status: `viberelay relaymind status

  Show the current session and supervisor health status.

Usage:
  viberelay relaymind status   Print health, pid, session name, and timestamps

Examples:
  viberelay relaymind status`,

  logs: `viberelay relaymind logs

  Tail recent supervisor log lines or capture the live tmux pane.

Usage:
  viberelay relaymind logs [N]          Show last N supervisor log lines (default: 50)
  viberelay relaymind logs --pane [N]   Capture the last N lines of the tmux pane

Examples:
  viberelay relaymind logs
  viberelay relaymind logs 100
  viberelay relaymind logs --pane 200`,

  attach: `viberelay relaymind attach

  Attach your terminal to the running tmux session so you can interact with
  Claude directly. Detach with Ctrl-b d (tmux's default prefix). Requires
  an interactive TTY.

Usage:
  viberelay relaymind attach

Examples:
  viberelay relaymind attach`,

  send: `viberelay relaymind send

  Send a line of text + Enter into the running tmux pane. Useful for
  programmatic input (self-edit restarts, automation). Refuses when no
  session is running.

Usage:
  viberelay relaymind send <text...>

Examples:
  viberelay relaymind send /restart
  viberelay relaymind send "summarize today and exit"`,
}

function isHelpFlag(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h') || argv[0] === 'help'
}

export default async function lifecycle(argv: string[]): Promise<string> {
  const verb = argv[0]
  if (!isVerb(verb)) {
    if (isHelpFlag(argv)) {
      return `viberelay relaymind <lifecycle-verb>

  Lifecycle management for the persistent Claude Code session.

Usage:
  viberelay relaymind start [--resume]
  viberelay relaymind stop
  viberelay relaymind restart [--plugin-only]
  viberelay relaymind status
  viberelay relaymind logs [N] [--pane]
  viberelay relaymind attach
  viberelay relaymind send <text...>

Run \`viberelay relaymind <verb> --help\` for per-verb help.`
    }
    return `viberelay relaymind: unknown lifecycle verb '${verb ?? ''}'. Expected one of: ${[...VERBS].join(', ')}.`
  }
  if (isHelpFlag(argv.slice(1))) {
    return VERB_HELP[verb]
  }
  const rest = argv.slice(1)
  const paths = relayMindPaths(process.cwd())

  switch (verb) {
    case 'start': {
      const meta = await startSession(paths, { resume: hasFlag(rest, '--resume') })
      return `started session=${meta.sessionName} pid=${meta.pid} status=${meta.status}`
    }
    case 'stop': {
      const r = await stopSession(paths)
      if (r.pid === null && !r.stopped) return 'stop: nothing to do (no session running)'
      return r.stopped
        ? `stopped pid=${r.pid ?? '?'}`
        : `stop: session was already absent (last pid=${r.pid ?? '?'})`
    }
    case 'restart': {
      const meta = await restartSession(paths, {
        pluginOnly: hasFlag(rest, '--plugin-only'),
      })
      return `restarted session=${meta.sessionName} pid=${meta.pid} status=${meta.status}`
    }
    case 'status': {
      const { health, meta } = await getStatus(paths)
      const lines = [
        `status: ${health.status}`,
        `checked: ${health.checkedAt}`,
      ]
      if (health.detail) lines.push(`detail: ${health.detail}`)
      if (meta) {
        lines.push(`session: ${meta.sessionName}`)
        lines.push(`pid: ${meta.pid}`)
        lines.push(`started: ${meta.startedAt}`)
        if (meta.claudeSessionId) lines.push(`claude-session: ${meta.claudeSessionId}`)
        if (meta.transcriptPath) lines.push(`transcript: ${meta.transcriptPath}`)
      } else {
        lines.push('session: <none>')
      }
      return lines.join('\n')
    }
    case 'logs': {
      const n = parseLogN(rest)
      if (hasFlag(rest, '--pane')) {
        const lines = await capturePane(paths, n)
        if (lines.length === 0) return '(no tmux session or empty pane)'
        return lines.join('\n')
      }
      const lines = await tailLogs(paths, n)
      if (lines.length === 0) return '(no supervisor log yet)'
      return lines.join('\n')
    }
    case 'attach': {
      const info = await attachSession(paths)
      if (!info.running) {
        return `attach: tmux session '${info.sessionName}' is not running. Start it with 'relaymind start'.`
      }
      const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true
      if (!isTty) {
        return `attach: stdin/stdout are not a TTY — running attach in a non-interactive shell would hang. Try: ${info.bin} ${info.args.join(' ')}`
      }
      // Replace this process with the user's tmux attach. We can't truly
      // exec from Node, but inheriting stdio + waiting is functionally
      // equivalent for the user.
      const child = spawn(info.bin, info.args, { stdio: 'inherit' })
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve())
      })
      return `attach: detached from session=${info.sessionName}`
    }
    case 'send': {
      if (rest.length === 0) {
        return "send: missing text. Usage: viberelay relaymind send <text...>"
      }
      const text = rest.join(' ')
      try {
        await sendKeys(paths, text)
        return `sent ${text.length} chars`
      } catch (err) {
        return `send: ${(err as Error).message}`
      }
    }
  }
}

/** Used by the verb shims to forward argv with the verb pre-pended. */
export async function runVerb(verb: Verb, argv: string[]): Promise<string> {
  return lifecycle([verb, ...argv])
}
