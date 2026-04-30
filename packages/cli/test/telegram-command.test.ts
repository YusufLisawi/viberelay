import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchTelegramCommand, runTelegramCommand } from '../src/commands/telegram.js'

const repoRoot = resolve(import.meta.dirname, '../../..')

let cwd: string
let workspace: string

beforeEach(async () => {
  cwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'viberelay-telegram-command-'))
  process.chdir(workspace)
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(workspace, { recursive: true, force: true })
})

describe('telegram command bridge', () => {
  it('returns unhandled for unknown commands', async () => {
    await writeRegistry([])

    await expect(dispatchTelegramCommand(request('missing'), 'http://127.0.0.1:8327')).resolves.toEqual({ handled: false })
  })

  it('renders llm commands from the profile registry', async () => {
    await writeRegistry([
      {
        name: 'self-improve',
        description: 'Improve the assistant from recent work',
        mode: 'llm',
        template: 'Improve this: {{args}}',
      },
    ])

    await expect(dispatchTelegramCommand(request('self-improve', 'inspect memory'), 'http://127.0.0.1:8327')).resolves.toEqual({
      handled: true,
      llmPrompt: 'Improve this: inspect memory',
    })
  })

  it('rejects invalid argv', async () => {
    await expect(runTelegramCommand({ argv: ['command', 'run'], baseUrl: 'http://127.0.0.1:8327' })).rejects.toThrow(
      /Usage: viberelay telegram command run --json/,
    )
  })

  it('runs through the CLI process from an explicit repo root', async () => {
    await writeRegistry([
      {
        name: 'self-improve',
        description: 'Improve the assistant from recent work',
        mode: 'llm',
        template: 'Improve this: {{args}}',
      },
    ])

    const output = await runCliProcess(workspace, request('self-improve', 'inspect memory'))

    expect(JSON.parse(output)).toEqual({
      handled: true,
      llmPrompt: 'Improve this: inspect memory',
    })
  })
})

async function writeRegistry(commands: unknown[]): Promise<void> {
  const dir = join(workspace, '.relaymind', 'claude-home', 'commands')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'registry.json'), `${JSON.stringify({ commands }, null, 2)}\n`)
}

function request(command: string, args = '') {
  return {
    schemaVersion: 1,
    command,
    args,
    chat: { id: '6477802820' },
  }
}

function runCliProcess(cwd: string, input: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [join(repoRoot, 'packages/cli/src/bin.ts'), 'telegram', 'command', 'run', '--json'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      reject(new Error(stderr || `CLI exited with ${code ?? 'unknown'}`))
    })
    child.stdin.end(JSON.stringify(input))
  })
}
