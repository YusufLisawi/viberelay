import { currentDaemonPid, isConnectionRefused, resolveDaemonPaths, spawnDaemon } from '../lib/daemon-control.js'

export interface StartCommandOptions {
  baseUrl: string
  wait?: boolean
}

export async function runStartCommand(options: StartCommandOptions): Promise<string> {
  const paths = resolveDaemonPaths()
  const existing = await currentDaemonPid(paths)
  if (existing) return `viberelay-daemon already running (pid ${existing})`

  const pid = await spawnDaemon(paths)
  if (options.wait === false) {
    return `viberelay-daemon started (pid ${pid})`
  }

  const ready = await waitForDaemon(options.baseUrl, 5000)
  if (!ready) return `viberelay-daemon started (pid ${pid}) but did not answer /status within 5s — check ${paths.logFile}`
  return `viberelay-daemon running on ${new URL(options.baseUrl).host} (pid ${pid})`
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
