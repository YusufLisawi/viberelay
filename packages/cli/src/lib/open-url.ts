import { spawn } from 'node:child_process'
import process from 'node:process'

export async function openUrl(url: string) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'

  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url]

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: process.platform !== 'win32' })
    child.once('error', reject)
    child.once('spawn', () => resolve())
    child.unref()
  })
}
