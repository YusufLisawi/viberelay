#!/usr/bin/env node
import process from 'node:process'
import { runAccountsCommand } from './commands/accounts.js'
import { runDashboardCommand } from './commands/dashboard.js'
import { runLogsCommand } from './commands/logs.js'
import { runMenubarCommand } from './commands/menubar.js'
import { runProfileCommand } from './commands/profile.js'
import { runServiceCommand } from './commands/service.js'
import { runStartCommand } from './commands/start.js'
import { runStatusCommand } from './commands/status.js'
import { runStopCommand } from './commands/stop.js'
import { runUpdateCommand } from './commands/update.js'
import { runUsageCommand, runUsageWatch } from './commands/usage.js'
import { VERSION } from './version.js'

const baseUrl = process.env.VIBERELAY_BASE_URL ?? 'http://127.0.0.1:8327'
const command = process.argv[2] ?? 'status'

function helpText(): string {
  return `viberelay ${VERSION}

Usage: viberelay <command>

Daemon lifecycle:
  start              Launch viberelay-daemon in the background (idempotent)
  stop               Stop the running daemon
  restart            Stop then start
  status             Daemon + accounts summary (safe when daemon is down)
  logs [N]           Tail last N lines of the daemon log (default 50)

Service registration (auto-start on login):
  autostart [enable|disable|status]   Alias for \`service\` with friendly verbs
  service install    Register launchd (macOS) or systemd --user (Linux)
  service uninstall  Remove the service
  service status     Query the service manager

Proxy:
  accounts           Account summary per provider
  usage [--once] [--watch] [--interval <ms>]
                     Request counts + 5h/weekly quotas (live refresh in TTY)
  dashboard          Open the web UI
  menubar ...        Install/remove the macOS SwiftBar menu-bar plugin (run \`viberelay menubar help\`)
  profile ... (p)    Manage local Claude profiles (run \`viberelay profile help\`)
  run [-d] <name>    Shortcut for \`viberelay profile run\` (also: \`r\`, \`exec\`)

Self-maintenance:
  update [--check] [--channel stable|nightly]
  --version`
}

async function main() {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(helpText() + '\n')
      return
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`viberelay ${VERSION}\n`)
      return
    case 'start':
      process.stdout.write(await runStartCommand({ baseUrl }) + '\n')
      return
    case 'stop':
      process.stdout.write(await runStopCommand({ baseUrl }) + '\n')
      return
    case 'restart':
      process.stdout.write(await runStopCommand({ baseUrl }) + '\n')
      process.stdout.write(await runStartCommand({ baseUrl }) + '\n')
      return
    case 'status':
      process.stdout.write(await runStatusCommand({ baseUrl }) + '\n')
      return
    case 'logs': {
      const tail = Number.parseInt(process.argv[3] ?? '50', 10)
      process.stdout.write(await runLogsCommand({ tail }) + '\n')
      return
    }
    case 'service':
      process.stdout.write(await runServiceCommand({}) + '\n')
      return
    case 'autostart': {
      // Alias: `autostart [enable|disable|status]` → `service [install|uninstall|status]`
      const sub = process.argv[3] ?? 'status'
      const map: Record<string, string> = { enable: 'install', on: 'install', disable: 'uninstall', off: 'uninstall', status: 'status' }
      const translated = map[sub] ?? sub
      process.stdout.write(await runServiceCommand({ argv: [translated, ...process.argv.slice(4)] }) + '\n')
      return
    }
    case 'accounts':
      process.stdout.write(await runAccountsCommand({ baseUrl }) + '\n')
      return
    case 'usage': {
      const args = process.argv.slice(3)
      const once = args.includes('--once')
      const json = args.includes('--json')
      const watchFlag = args.includes('--watch') || args.includes('-w')
      const intervalIdx = args.indexOf('--interval')
      const intervalMs = intervalIdx >= 0 ? Math.max(500, Number.parseInt(args[intervalIdx + 1] ?? '2000', 10)) : 2000
      const shouldWatch = !json && (watchFlag || (!once && (process.stdout.isTTY ?? false)))
      if (shouldWatch) {
        await runUsageWatch({ baseUrl, intervalMs })
        return
      }
      process.stdout.write(await runUsageCommand({ baseUrl, json }) + '\n')
      return
    }
    case 'dashboard':
      process.stdout.write(await runDashboardCommand({ baseUrl }) + '\n')
      return
    case 'menubar':
      process.stdout.write(await runMenubarCommand({}) + '\n')
      return
    case 'profile':
    case 'p':
      process.stdout.write(await runProfileCommand({ baseUrl }) + '\n')
      return
    case 'run':
    case 'r':
    case 'exec': {
      // Top-level shortcut: `viberelay run [-d] <name>` == `viberelay profile run ...`
      const argv = ['run', ...process.argv.slice(3)]
      process.stdout.write(await runProfileCommand({ baseUrl, argv }) + '\n')
      return
    }
    case 'update': {
      const args = process.argv.slice(3)
      const check = args.includes('--check')
      const force = args.includes('--force')
      const nightlyIdx = args.indexOf('--channel')
      const channel = nightlyIdx >= 0 && args[nightlyIdx + 1] === 'nightly' ? 'nightly' : 'stable'
      process.stdout.write(await runUpdateCommand({ check, force, channel }) + '\n')
      return
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${helpText()}\n`)
      process.exit(1)
  }
}

void main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
