import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type TelegramCommandMode = 'direct' | 'llm'
export type TelegramCommandRisk = 'read' | 'write' | 'external' | 'destructive'

export interface TelegramCommandEntry {
  name: string
  description: string
  mode: TelegramCommandMode
  enabled: boolean
  handler?: string
  template?: string
  /** Optional risk classification. Undefined means unspecified. */
  risk?: TelegramCommandRisk
}

export interface TelegramCommandRegistry {
  commands: TelegramCommandEntry[]
}

export interface TelegramBotCommand {
  command: string
  description: string
}

const DEFAULT_COMMANDS: TelegramCommandEntry[] = [
  {
    name: 'start',
    description: 'Welcome and setup guide',
    mode: 'direct',
    enabled: true,
    handler: 'start',
  },
  {
    name: 'help',
    description: 'What this bot can do',
    mode: 'direct',
    enabled: true,
    handler: 'help',
  },
  {
    name: 'status',
    description: 'Check your pairing status',
    mode: 'direct',
    enabled: true,
    handler: 'status',
  },
  {
    name: 'commands',
    description: 'List available commands',
    mode: 'direct',
    enabled: true,
    handler: 'commands',
  },
  {
    name: 'usage',
    description: 'Show viberelay usage',
    mode: 'direct',
    enabled: true,
    handler: 'usage',
  },
  {
    name: 'fix',
    description: 'Investigate and fix an issue',
    mode: 'llm',
    enabled: true,
    template: [
      'You are handling the /fix command.',
      'Investigate the issue below and make the smallest correct change.',
      '',
      'User request:',
      '{{args}}',
    ].join('\n'),
  },
  {
    name: 'build',
    description: 'Plan or implement a feature',
    mode: 'llm',
    enabled: true,
    template: [
      'You are handling the /build command.',
      'Design and implement the requested feature with minimal, correct changes.',
      '',
      'User request:',
      '{{args}}',
    ].join('\n'),
  },
  {
    name: 'daily',
    description: 'Prepare a daily summary',
    mode: 'llm',
    enabled: true,
    template: [
      'You are handling the /daily command.',
      'Summarize the current work, decisions, and next steps.',
      '',
      'User context:',
      '{{args}}',
    ].join('\n'),
  },
]

export function defaultTelegramCommandRegistry(): TelegramCommandRegistry {
  return { commands: DEFAULT_COMMANDS }
}

export function registryPathFromMetaUrl(metaUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('./commands/registry.json', metaUrl))
}

export function loadTelegramCommandRegistry(registryPath = registryPathFromMetaUrl()): TelegramCommandRegistry {
  try {
    const raw = readFileSync(registryPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<TelegramCommandRegistry>
    const commands = Array.isArray(parsed.commands) ? parsed.commands : []
    return {
      commands: commands.map(command => normalizeTelegramCommandEntry(command)),
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultTelegramCommandRegistry()
    }
    throw err
  }
}

export function normalizeTelegramCommandEntry(command: Partial<TelegramCommandEntry>): TelegramCommandEntry {
  const name = normalizeTelegramCommandName(command.name)
  if (!name) throw new Error('telegram command registry entry is missing a command name')
  if (typeof command.description !== 'string' || command.description.trim() === '') {
    throw new Error(`telegram command registry entry ${name} is missing a description`)
  }
  const mode = command.mode ?? 'llm'
  if (mode !== 'direct' && mode !== 'llm') {
    throw new Error(`telegram command registry entry ${name} has unsupported mode ${mode}`)
  }
  if (mode === 'direct' && (typeof command.handler !== 'string' || command.handler.trim() === '')) {
    throw new Error(`telegram command registry entry ${name} is missing a direct handler`)
  }
  if (mode === 'llm' && (typeof command.template !== 'string' || command.template.trim() === '')) {
    throw new Error(`telegram command registry entry ${name} is missing template text`)
  }
  const VALID_RISKS = new Set<TelegramCommandRisk>(['read', 'write', 'external', 'destructive'])
  const risk: TelegramCommandRisk | undefined =
    command.risk !== undefined && VALID_RISKS.has(command.risk as TelegramCommandRisk)
      ? (command.risk as TelegramCommandRisk)
      : undefined
  return {
    name,
    description: command.description.trim(),
    mode,
    enabled: command.enabled ?? true,
    handler: command.handler?.trim(),
    template: command.template,
    risk,
  }
}

export function normalizeTelegramCommandName(name: string | undefined): string | undefined {
  const normalized = name?.trim().replace(/^\//, '').toLowerCase()
  return normalized && /^[a-z][a-z0-9_-]{0,31}$/.test(normalized) ? normalized : undefined
}

function isTelegramBotMenuCommandName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,31}$/.test(name)
}

export function parseTelegramSlashCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\s*\/([a-zA-Z][a-zA-Z0-9_-]{0,31})(?:@[\w_]+)?(?:\s+([\s\S]*))?$/.exec(text)
  const name = normalizeTelegramCommandName(match?.[1])
  if (!name) return undefined
  return { name, args: match?.[2]?.trim() ?? '' }
}

export function findTelegramCommand(registry: TelegramCommandRegistry, name: string): TelegramCommandEntry | undefined {
  return registry.commands.find(command => command.enabled && command.name === name)
}

export function renderTelegramCommandPrompt(command: TelegramCommandEntry, args: string): string {
  if (command.mode !== 'llm' || !command.template) {
    throw new Error(`telegram command ${command.name} is not an LLM command`)
  }
  const input = args.trim()
  return command.template.includes('{{args}}')
    ? command.template.replaceAll('{{args}}', input)
    : (input ? `${command.template.trim()}\n\n${input}` : command.template.trim())
}

export function buildTelegramBotCommands(commands: TelegramCommandEntry[]): TelegramBotCommand[] {
  return commands
    .filter(command => command.enabled && isTelegramBotMenuCommandName(command.name))
    .map(command => ({ command: command.name, description: command.description }))
}
