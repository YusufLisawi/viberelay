#!/usr/bin/env node
import process from 'node:process'
import { runAccountsCommand } from './commands/accounts.js'
import { runDashboardCommand } from './commands/dashboard.js'
import { runProfileCommand } from './commands/profile.js'
import { runStartCommand } from './commands/start.js'
import { runStatusCommand } from './commands/status.js'
import { runStopCommand } from './commands/stop.js'
import { runUpdateCommand } from './commands/update.js'
import { runUsageCommand } from './commands/usage.js'
import { VERSION } from './version.js'

const baseUrl = process.env.VIBERELAY_BASE_URL ?? 'http://127.0.0.1:8327'
const command = process.argv[2] ?? 'status'

async function main() {
  switch (command) {
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
    case 'status':
      process.stdout.write(await runStatusCommand({ baseUrl }) + '\n')
      return
    case 'accounts':
      process.stdout.write(await runAccountsCommand({ baseUrl }) + '\n')
      return
    case 'usage':
      process.stdout.write(await runUsageCommand({ baseUrl }) + '\n')
      return
    case 'dashboard':
      process.stdout.write(await runDashboardCommand({ baseUrl }) + '\n')
      return
    case 'profile':
      process.stdout.write(await runProfileCommand({ baseUrl }) + '\n')
      return
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
      process.stderr.write(`Unknown command: ${command}\n`)
      process.exit(1)
  }
}

void main()
