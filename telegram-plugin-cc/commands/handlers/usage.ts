import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DirectCommandHandler } from '../handlers.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = join(import.meta.dirname, '../../..')
const MAX_OUTPUT_LENGTH = 3500

export const handle: DirectCommandHandler = async () => {
  try {
    const { stdout, stderr } = await execFileAsync(
      'bunx',
      ['tsx', 'packages/cli/src/bin.ts', 'usage'],
      { cwd: REPO_ROOT, timeout: 15_000 },
    )
    return renderResult('viberelay usage:', stdout, stderr)
  } catch (error) {
    const err = error as { stdout?: string, stderr?: string, code?: number | string, signal?: string }
    const reason = err.signal ? `signal ${err.signal}` : `exit code ${err.code ?? 'unknown'}`
    return renderResult(`viberelay usage failed with ${reason}:`, err.stdout ?? '', err.stderr ?? '')
  }
}

function renderResult(prefix: string, stdout: string, stderr: string): { text: string } {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  const body = output || '(no output)'
  const truncated = body.length > MAX_OUTPUT_LENGTH
    ? `${body.slice(0, MAX_OUTPUT_LENGTH)}\n… truncated`
    : body

  return { text: `${prefix}\n\n${truncated}` }
}
