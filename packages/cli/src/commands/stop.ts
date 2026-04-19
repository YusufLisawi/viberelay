import { clearPidFile, currentDaemonPid, killDaemon, resolveDaemonPaths } from '../lib/daemon-control.js'

export interface StopCommandOptions {
  baseUrl?: string
}

export async function runStopCommand(_options: StopCommandOptions = {}): Promise<string> {
  const paths = resolveDaemonPaths()
  const pid = await currentDaemonPid(paths)
  if (!pid) {
    await clearPidFile(paths)
    return 'viberelay-daemon not running'
  }
  await killDaemon(pid)
  await clearPidFile(paths)
  return `viberelay-daemon stopped (pid ${pid})`
}
