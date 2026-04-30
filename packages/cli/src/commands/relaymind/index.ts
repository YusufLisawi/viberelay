/**
 * `viberelay relaymind <subcommand>` registrar.
 *
 * This file is the spine. Subcommand modules in this directory are owned by
 * different work streams (memory, installer, supervisor, daily, etc.). All
 * imports are static so `bun --compile` bundles every handler into the
 * standalone binary — dynamic-template imports (`import(./${name}.js)`) are
 * not statically analyzable and would silently drop subcommands at compile
 * time.
 */

import bridgeCommand from './bridge.js'
import checkpointCommand from './checkpoint.js'
import contextCommand from './context.js'
import dailyCommand from './daily.js'
import doctorCommand from './doctor.js'
import initCommand from './init.js'
import lifecycleCommand from './lifecycle.js'
import memCommand from './mem.js'
import pluginCommand from './plugin.js'
import selfCommand from './self.js'
import setupCommand from './setup.js'
import telegramCommand from './telegram.js'
import watchdogCommand from './watchdog.js'

type SubcommandHandler = (argv: string[], baseUrl: string) => Promise<string> | string

// All known subcommands. Lifecycle verbs (start/stop/restart/status/logs)
// route into a single lifecycle.ts module that switches on the verb.
// Some handlers take only `argv` — JS happily ignores the extra `baseUrl`
// arg at runtime; the cast satisfies TypeScript.
const lifecycle = (verb: string): SubcommandHandler =>
  (argv) => lifecycleCommand([verb, ...argv])
const HANDLERS: Record<string, SubcommandHandler> = {
  bridge: bridgeCommand,
  checkpoint: checkpointCommand,
  context: contextCommand,
  daily: dailyCommand,
  doctor: doctorCommand as SubcommandHandler,
  init: initCommand as SubcommandHandler,
  logs: lifecycle('logs'),
  mem: memCommand,
  plugin: pluginCommand as SubcommandHandler,
  restart: lifecycle('restart'),
  self: selfCommand,
  setup: setupCommand as SubcommandHandler,
  start: lifecycle('start'),
  status: lifecycle('status'),
  stop: lifecycle('stop'),
  attach: lifecycle('attach'),
  send: lifecycle('send'),
  telegram: telegramCommand,
  watchdog: watchdogCommand,
}

function helpText(): string {
  return `RelayMind — persistent Claude Code assistant

Setup:
  init                    First-time setup wizard
  setup                   Re-run setup steps idempotently
  doctor                  Diagnose installation health

Lifecycle:
  start                   Start the persistent Claude Code session (tmux-hosted)
  stop                    Stop the session
  restart [--plugin-only] Restart (optionally plugin-only)
  status                  Show session + supervisor status
  logs [N] [--pane]       Tail supervisor logs (or capture tmux pane with --pane)
  attach                  Attach your terminal to the running tmux session
  send <text...>          Send a line of text + Enter into the running tmux pane

Memory:
  mem add --type T --title T --body T [--source S] [--importance N]
  mem search "<query>" [--limit N] [--type T]
  mem get <id> [...ids]
  mem link <from> <to> --rel R
  mem related <id>
  mem update <id> [--title T] [--body T] [--importance N]
  mem delete <id>

Checkpoints / context:
  checkpoint write
  checkpoint maybe
  checkpoint latest
  context render --event <session-start|user-prompt|pre-compact|stop>

Daily summaries:
  daily summarize         Trigger Claude to summarize today
  daily show [date]
  daily search "<query>"

Telegram:
  telegram setup
  telegram pair
  telegram status
  telegram commands list|add|validate|reload

Plugin:
  plugin install
  plugin verify

Watchdog:
  watchdog start [--foreground]
  watchdog stop|status|tick

Telegram bridge (Anthropic issue #36503 workaround):
  bridge start [--foreground] [--interval <ms>]
  bridge stop|status|tick

Self-maintenance:
  self validate
  self snapshot
  self rollback

Equivalent: \`viberelay relaymind <cmd>\` and \`relaymind <cmd>\`.`
}

export async function runRelaymindCommand(opts: {
  argv: string[]
  baseUrl: string
}): Promise<string> {
  const { argv, baseUrl } = opts
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    return helpText()
  }

  const handler = HANDLERS[sub]
  if (!handler) {
    return `viberelay relaymind ${sub}: unknown subcommand.\n\n${helpText()}`
  }
  return await handler(argv.slice(1), baseUrl)
}
