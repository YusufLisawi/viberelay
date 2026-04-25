import { spawn } from 'node:child_process'
import { openUrl } from '../lib/open-url.js'

export interface DashboardCommandOptions {
  baseUrl: string
  argv?: string[]
  openUrl?: (url: string) => Promise<void>
}

interface RemoteSpec {
  target: string
  sshPort: number
  remotePort: number
  localPort: number
}

function parseRemoteArgs(argv: string[]): RemoteSpec | null {
  let target = ''
  let sshPort = 22
  let remotePort = 8327
  let localPort = 18327

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--ssh-port' || arg === '-p') {
      sshPort = Number.parseInt(argv[++i] ?? '22', 10)
    } else if (arg === '--remote-port') {
      remotePort = Number.parseInt(argv[++i] ?? '8327', 10)
    } else if (arg === '--local-port') {
      localPort = Number.parseInt(argv[++i] ?? '18327', 10)
    } else if (!arg.startsWith('-')) {
      if (target) throw new Error(`unexpected positional argument: ${arg}`)
      target = arg
    } else {
      throw new Error(`unknown flag: ${arg}`)
    }
  }

  if (!target) return null
  return { target, sshPort, remotePort, localPort }
}

export async function runDashboardCommand(options: DashboardCommandOptions) {
  const argv = options.argv ?? process.argv.slice(3)
  const remote = parseRemoteArgs(argv)

  if (!remote) {
    const url = `${options.baseUrl}/dashboard`
    await (options.openUrl ?? openUrl)(url)
    return `opened ${url}`
  }

  const tunnelUrl = `http://127.0.0.1:${remote.localPort}/dashboard`
  process.stdout.write(`→ tunneling ${remote.target}:${remote.remotePort} → 127.0.0.1:${remote.localPort}\n`)
  process.stdout.write('  ssh tunnel running. Ctrl-C to stop.\n')

  const child = spawn('ssh', [
    '-N',
    '-L', `${remote.localPort}:127.0.0.1:${remote.remotePort}`,
    '-p', String(remote.sshPort),
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    remote.target
  ], { stdio: 'inherit' })

  const onSigint = () => child.kill('SIGINT')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigint)

  setTimeout(() => {
    void (options.openUrl ?? openUrl)(tunnelUrl).catch(() => {
      process.stdout.write(`  open this URL manually: ${tunnelUrl}\n`)
    })
  }, 1500)

  await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigint)

  return `tunnel closed (${remote.target})`
}
