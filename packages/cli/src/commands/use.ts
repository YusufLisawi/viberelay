import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runStartCommand } from './start.js'
import { runStopCommand } from './stop.js'

interface UseCommandOptions {
  baseUrl: string
  argv?: string[]
}

interface ActiveState {
  mode: 'local' | 'remote'
  target?: string
  sshPid?: number
  sshPort?: number
  remotePort?: number
  localPort?: number
  since?: string
}

const DEFAULT_LOCAL_PORT = 8327
const DEFAULT_REMOTE_PORT = 8327

function statePath(): string {
  return join(homedir(), '.viberelay', 'state', 'active.json')
}

async function readState(): Promise<ActiveState> {
  try {
    const raw = await readFile(statePath(), 'utf8')
    return JSON.parse(raw) as ActiveState
  } catch {
    return { mode: 'local' }
  }
}

async function writeState(state: ActiveState): Promise<void> {
  await mkdir(dirname(statePath()), { recursive: true })
  await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function helpText(): string {
  return `viberelay use — switch between local and remote viberelay daemons

Usage:
  viberelay use local                  Run the daemon on this machine (default)
  viberelay use remote <user@host>     Stop local, tunnel a remote daemon to 127.0.0.1
  viberelay use show                   Show the active mode
  viberelay use refresh                Reconcile state (clears dead tunnel pids)

Tunnel options (with \`use remote\`):
  --ssh-port <n>      SSH port on the remote (default 22)
  --remote-port <n>   Remote viberelay port (default 8327)
  --local-port <n>    Local listen port (default 8327)

Once tunneled, every viberelay client keeps using http://127.0.0.1:8327 — the
SwiftBar plugin, Claude Code profiles, openclaw, dashboards, the lot. No
client config changes needed. Switch back with \`viberelay use local\`.`
}

interface RemoteArgs {
  target: string
  sshPort: number
  remotePort: number
  localPort: number
}

function parseRemoteArgs(rest: string[]): RemoteArgs {
  let target = ''
  let sshPort = 22
  let remotePort = DEFAULT_REMOTE_PORT
  let localPort = DEFAULT_LOCAL_PORT
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg) continue
    if (arg === '--ssh-port') sshPort = Number.parseInt(rest[++i] ?? '22', 10)
    else if (arg === '--remote-port') remotePort = Number.parseInt(rest[++i] ?? String(DEFAULT_REMOTE_PORT), 10)
    else if (arg === '--local-port') localPort = Number.parseInt(rest[++i] ?? String(DEFAULT_LOCAL_PORT), 10)
    else if (!arg.startsWith('-')) {
      if (target) throw new Error(`unexpected positional argument: ${arg}`)
      target = arg
    } else {
      throw new Error(`unknown flag: ${arg}`)
    }
  }
  if (!target) throw new Error('remote target required (e.g. user@host)')
  return { target, sshPort, remotePort, localPort }
}

async function waitForPort(port: number, openExpected: boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) {
        if (openExpected) return true
      } else if (!openExpected) return true
    } catch {
      if (!openExpected) return true
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function reconcile(): Promise<ActiveState> {
  const state = await readState()
  if (state.mode === 'remote' && state.sshPid && !isAlive(state.sshPid)) {
    const next: ActiveState = { mode: 'local' }
    await writeState(next)
    return next
  }
  return state
}

function fmtState(state: ActiveState): string {
  if (state.mode === 'local') return 'mode: local'
  const target = state.target ?? '?'
  const port = state.localPort ?? DEFAULT_LOCAL_PORT
  const alive = state.sshPid ? (isAlive(state.sshPid) ? 'alive' : 'dead') : '?'
  return `mode: remote → ${target} (tunnel 127.0.0.1:${port}, ssh pid ${state.sshPid ?? '?'}: ${alive})`
}

export async function runUseCommand(options: UseCommandOptions): Promise<string> {
  const argv = options.argv ?? process.argv.slice(3)
  const sub = argv[0] ?? 'show'

  if (sub === 'help' || sub === '--help' || sub === '-h') return helpText()

  if (sub === 'show') return fmtState(await reconcile())

  if (sub === 'refresh') {
    const state = await reconcile()
    return fmtState(state)
  }

  if (sub === 'local') {
    const state = await readState()
    if (state.mode === 'remote' && state.sshPid && isAlive(state.sshPid)) {
      try { process.kill(state.sshPid, 'SIGTERM') } catch { /* gone */ }
      await waitForPort(state.localPort ?? DEFAULT_LOCAL_PORT, false, 5000)
    }
    await writeState({ mode: 'local' })
    const startMsg = await runStartCommand({ baseUrl: options.baseUrl })
    return `${startMsg}\nmode: local`
  }

  if (sub === 'remote') {
    const remoteArgs = parseRemoteArgs(argv.slice(1))

    // Kick the local daemon off the port first.
    try { await runStopCommand({ baseUrl: options.baseUrl }) } catch { /* already stopped */ }
    await waitForPort(remoteArgs.localPort, false, 3000)

    const child = spawn('ssh', [
      '-N',
      '-L', `${remoteArgs.localPort}:127.0.0.1:${remoteArgs.remotePort}`,
      '-p', String(remoteArgs.sshPort),
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      remoteArgs.target
    ], { detached: true, stdio: 'ignore' })
    child.unref()

    const ready = await waitForPort(remoteArgs.localPort, true, 12_000)
    if (!ready) {
      try { process.kill(child.pid ?? 0, 'SIGTERM') } catch { /* ignore */ }
      throw new Error(`tunnel didn't come up — check that ssh ${remoteArgs.target} works and that viberelay is running on the remote`)
    }

    const state: ActiveState = {
      mode: 'remote',
      target: remoteArgs.target,
      sshPid: child.pid,
      sshPort: remoteArgs.sshPort,
      remotePort: remoteArgs.remotePort,
      localPort: remoteArgs.localPort,
      since: new Date().toISOString()
    }
    await writeState(state)
    return `✓ ${fmtState(state)}\n  every viberelay client now hits the remote daemon transparently.`
  }

  return helpText()
}

export async function readActiveMode(): Promise<ActiveState> {
  return reconcile()
}
