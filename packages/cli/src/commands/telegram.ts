import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runUsageCommand } from './usage.js'

const MAX_OUTPUT_LENGTH = 3500

type TelegramCommandMode = 'direct' | 'llm'

type TelegramCommand = {
  name: string
  description: string
  mode: TelegramCommandMode
  enabled?: boolean
  handler?: string
  template?: string
}

type TelegramCommandRegistry = {
  commands: TelegramCommand[]
}

type TelegramCommandRequest = {
  schemaVersion?: number
  command: string
  args: string
  chat: { id: string }
  user?: { id?: string, username?: string }
  message?: { id?: string, text?: string, ts?: string }
}

type TelegramCommandResult =
  | { handled: true, text: string, files?: string[] }
  | { handled: true, llmPrompt: string }
  | { handled: false }

export async function runTelegramCommand({ argv = process.argv.slice(3), baseUrl }: { argv?: string[], baseUrl: string }): Promise<string> {
  if (argv[0] !== 'command' || argv[1] !== 'run' || !argv.includes('--json')) {
    throw new Error('Usage: viberelay telegram command run --json')
  }

  const request = JSON.parse(await readStdin()) as TelegramCommandRequest
  const result = await dispatchTelegramCommand(request, baseUrl)
  return JSON.stringify(result)
}

export async function dispatchTelegramCommand(request: TelegramCommandRequest, baseUrl: string): Promise<TelegramCommandResult> {
  const commandName = normalizeCommandName(request.command)
  if (!commandName) return { handled: false }

  const registry = loadRegistry()
  const command = registry.commands.find(entry => entry.enabled !== false && normalizeCommandName(entry.name) === commandName)
  if (!command) return { handled: false }

  if (command.mode === 'llm') {
    if (!command.template) return { handled: false }
    return { handled: true, llmPrompt: command.template.replaceAll('{{args}}', request.args) }
  }

  if (command.handler === 'usage') {
    const text = await runUsageCommand({ baseUrl, json: false })
    return { handled: true, text: truncate(`viberelay usage:\n\n${text}`) }
  }

  if (!command.handler) return { handled: false }

  const handlerPath = join(commandsDir(), 'handlers', `${command.handler}.ts`)
  if (!existsSync(handlerPath)) return { handled: true, text: `Command /${commandName} has no installed handler.` }

  const stdout = await runHandlerProcess(handlerPath, request)
  const result = JSON.parse(stdout) as TelegramCommandResult
  return normalizeResult(result)
}

function runHandlerProcess(handlerPath: string, request: TelegramCommandRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [handlerPath], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('handler timed out'))
    }, 15_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      reject(new Error(stderr || `handler exited with ${code ?? 'unknown'}`))
    })
    child.stdin.end(JSON.stringify(request))
  })
}

function loadRegistry(): TelegramCommandRegistry {
  const registryPath = join(commandsDir(), 'registry.json')
  if (!existsSync(registryPath)) return defaultRegistry()
  return normalizeRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as TelegramCommandRegistry)
}

function commandsDir(): string {
  return join(process.cwd(), '.relaymind', 'claude-home', 'commands')
}

function defaultRegistry(): TelegramCommandRegistry {
  return {
    commands: [
      { name: 'usage', description: 'Show viberelay usage', mode: 'direct', enabled: true, handler: 'usage' },
      {
        name: 'fix',
        description: 'Investigate and fix an issue',
        mode: 'llm',
        enabled: true,
        template: 'You are handling the /fix command.\nInvestigate the issue below and make the smallest correct change.\n\nUser request:\n{{args}}',
      },
      {
        name: 'build',
        description: 'Plan or implement a feature',
        mode: 'llm',
        enabled: true,
        template: 'You are handling the /build command.\nDesign and implement the requested feature with minimal, correct changes.\n\nUser request:\n{{args}}',
      },
      {
        name: 'daily',
        description: 'Prepare a daily summary',
        mode: 'llm',
        enabled: true,
        template: 'You are handling the /daily command.\nSummarize the current work, decisions, and next steps.\n\nUser context:\n{{args}}',
      },
    ],
  }
}

function normalizeRegistry(registry: TelegramCommandRegistry): TelegramCommandRegistry {
  return {
    commands: Array.isArray(registry.commands) ? registry.commands.filter(command => normalizeCommandName(command.name)) : [],
  }
}

function normalizeCommandName(name: string | undefined): string | undefined {
  const value = name?.trim().toLowerCase().replace(/^\//, '')
  return value && /^[a-z][a-z0-9_-]{0,31}$/.test(value) ? value : undefined
}

function normalizeResult(result: TelegramCommandResult): TelegramCommandResult {
  if (!result.handled) return { handled: false }
  if ('llmPrompt' in result && result.llmPrompt) return { handled: true, llmPrompt: result.llmPrompt }
  if ('text' in result && result.text) return { handled: true, text: truncate(result.text), ...('files' in result ? { files: result.files } : {}) }
  return { handled: false }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_LENGTH ? `${text.slice(0, MAX_OUTPUT_LENGTH)}\n… truncated` : text
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}
