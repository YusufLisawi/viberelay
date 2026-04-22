import { clearPidFile, currentDaemonPid, isAlive, isConnectionRefused, killDaemon, resolveDaemonPaths } from '../lib/daemon-control.js'

export interface StopCommandOptions {
  baseUrl?: string
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8327'

export async function runStopCommand(options: StopCommandOptions = {}): Promise<string> {
  const paths = resolveDaemonPaths()
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL

  const pidFromFile = await currentDaemonPid(paths)
  if (pidFromFile) {
    await killDaemon(pidFromFile)
    await clearPidFile(paths)
    return `viberelay-daemon stopped (pid ${pidFromFile})`
  }

  // No live pidfile — daemon may have been launched outside the CLI
  // (SwiftBar, tsx runner, launchd/systemd). Probe HTTP and shut it down
  // via the daemon's own shutdown endpoint.
  const httpPid = await shutdownViaHttp(baseUrl)
  if (httpPid !== null) {
    if (httpPid > 0) await waitUntilDead(httpPid, 3000)
    await clearPidFile(paths)
    return httpPid > 0
      ? `viberelay-daemon stopped (pid ${httpPid})`
      : 'viberelay-daemon stopped'
  }

  await clearPidFile(paths)
  return 'viberelay-daemon not running'
}

async function shutdownViaHttp(baseUrl: string): Promise<number | null> {
  let pid = 0
  try {
    const statusRes = await fetch(`${baseUrl}/status`)
    if (statusRes.ok) {
      const body = await statusRes.json() as { proxy?: { pid?: number } }
      if (typeof body.proxy?.pid === 'number') pid = body.proxy.pid
    }
  } catch (error) {
    if (isConnectionRefused(error)) return null
    // Non-refused errors (e.g. 404 during upgrade) still mean something is
    // listening — fall through to the shutdown request.
  }

  try {
    const res = await fetch(`${baseUrl}/relay/shutdown`, { method: 'POST' })
    if (!res.ok) return null
    if (pid === 0) {
      try {
        const body = await res.json() as { pid?: number }
        if (typeof body.pid === 'number') pid = body.pid
      } catch { /* ignore */ }
    }
    return pid
  } catch (error) {
    if (isConnectionRefused(error)) return null
    throw error
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
