import { readFile, stat } from 'node:fs/promises'
import { resolveDaemonPaths } from '../lib/daemon-control.js'

export interface LogsCommandOptions {
  tail?: number
}

export async function runLogsCommand(options: LogsCommandOptions = {}): Promise<string> {
  const paths = resolveDaemonPaths()
  try {
    await stat(paths.logFile)
  } catch {
    return `no log file yet at ${paths.logFile}`
  }
  const raw = await readFile(paths.logFile, 'utf8')
  const lines = raw.split('\n')
  const n = options.tail ?? 50
  return lines.slice(-Math.max(1, n) - 1).join('\n').trimEnd()
}
