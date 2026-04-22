import { acquireLock, currentDaemonPid, isConnectionRefused, releaseLock, resolveDaemonPaths, spawnDaemon } from '../lib/daemon-control.js'

export interface StartCommandOptions {
  baseUrl: string
  wait?: boolean
}

export async function runStartCommand(options: StartCommandOptions): Promise<string> {
  const paths = resolveDaemonPaths()

  // Acquire exclusive lock to prevent concurrent start races (TOCTOU).
  const locked = await acquireLock(paths)
  if (!locked) {
    // Another start is in progress or the daemon is already live.
    const existing = await currentDaemonPid(paths)
    if (existing) return `viberelay-daemon already running (pid ${existing})`
    const httpPid = await probeRunningDaemonPid(options.baseUrl)
    if (httpPid !== null) return `viberelay-daemon already running (pid ${httpPid})`
    return 'viberelay-daemon start already in progress — please wait'
  }

  try {
    // Re-check inside the lock to handle any race before we got here.
    const existing = await currentDaemonPid(paths)
    if (existing) return `viberelay-daemon already running (pid ${existing})`

    // A daemon may already be listening (SwiftBar, launchd, tsx runner) with
    // no matching pidfile. Probe HTTP so we don't spawn a duplicate that
    // crashes on port-in-use.
    const httpPid = await probeRunningDaemonPid(options.baseUrl)
    if (httpPid !== null) {
      await releaseLock(paths)
      return `viberelay-daemon already running (pid ${httpPid})`
    }

    const pid = await spawnDaemon(paths)
    // PID file is now written — safe to drop the lock.
    await releaseLock(paths)

    if (options.wait === false) {
      return `viberelay-daemon started (pid ${pid})`
    }

    const ready = await waitForDaemon(options.baseUrl, 5000)
    if (!ready) return `viberelay-daemon started (pid ${pid}) but did not answer /status within 5s — check ${paths.logFile}`
    return `viberelay-daemon running on ${new URL(options.baseUrl).host} (pid ${pid})`
  } catch (error) {
    // Always remove the lock on failure so the next attempt can proceed.
    await releaseLock(paths)
    throw error
  }
}

async function probeRunningDaemonPid(baseUrl: string): Promise<number | null> {
  try {
    const response = await fetch(`${baseUrl}/status`)
    if (!response.ok) return null
    const body = await response.json() as { proxy?: { pid?: number } }
    return typeof body.proxy?.pid === 'number' ? body.proxy.pid : 0
  } catch (error) {
    if (isConnectionRefused(error)) return null
    return null
  }
}

async function waitForDaemon(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return true
    } catch (error) {
      if (!isConnectionRefused(error)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}
