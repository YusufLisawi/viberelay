import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile, open } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

export interface DaemonPaths {
  stateDir: string
  pidFile: string
  logFile: string
  daemonBinary: string
}

export function resolveDaemonPaths(): DaemonPaths {
  const stateDir = process.env.VIBERELAY_STATE_DIR ?? join(homedir(), '.viberelay', 'state')
  return {
    stateDir,
    pidFile: join(stateDir, 'daemon.pid'),
    logFile: join(stateDir, 'daemon.log'),
    daemonBinary: resolveDaemonBinary()
  }
}

function resolveDaemonBinary(): string {
  if (process.env.VIBERELAY_DAEMON_BINARY) return process.env.VIBERELAY_DAEMON_BINARY
  const exe = process.platform === 'win32' ? 'viberelay-daemon.exe' : 'viberelay-daemon'
  return join(dirname(process.execPath), exe)
}

export async function readPid(pidFile: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFile, 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function currentDaemonPid(paths: DaemonPaths): Promise<number | null> {
  const pid = await readPid(paths.pidFile)
  if (!pid) return null
  return isAlive(pid) ? pid : null
}

export async function spawnDaemon(paths: DaemonPaths): Promise<number> {
  await mkdir(paths.stateDir, { recursive: true })
  await access(paths.daemonBinary)
  const logHandle = await open(paths.logFile, 'a')
  try {
    const child = spawn(paths.daemonBinary, [], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd]
    })
    child.unref()
    if (!child.pid) throw new Error('failed to spawn viberelay-daemon')
    await writeFile(paths.pidFile, `${child.pid}\n`, 'utf8')
    return child.pid
  } finally {
    await logHandle.close()
  }
}

export async function killDaemon(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM') } catch { return }
  for (let i = 0; i < 30; i += 1) {
    if (!isAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

export async function clearPidFile(paths: DaemonPaths): Promise<void> {
  await rm(paths.pidFile, { force: true })
}

export function isConnectionRefused(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }
  const code = err?.code ?? err?.cause?.code
  return code === 'ECONNREFUSED' || code === 'ConnectionRefused'
}
