import { describe, expect, it } from 'vitest'
import {
  buildTelegramBotCommands,
  defaultTelegramCommandRegistry,
  findTelegramCommand,
  loadTelegramCommandRegistry,
  normalizeTelegramCommandEntry,
  parseTelegramSlashCommand,
  renderTelegramCommandPrompt,
} from '../command-registry.js'
import { loadDirectCommandHandler } from '../commands/handlers.js'

describe('telegram command registry', () => {
  it('loads direct and LLM commands from registry.json', () => {
    const registry = loadTelegramCommandRegistry()

    expect(registry.commands.map(command => command.name)).toEqual([
      'start',
      'help',
      'status',
      'commands',
      'usage',
      'fix',
      'build',
      'daily',
    ])
    expect(findTelegramCommand(registry, 'status')?.mode).toBe('direct')
    expect(findTelegramCommand(registry, 'fix')?.template).toContain('/fix command')
  })

  it('renders prompt text from template and args', () => {
    const command = normalizeTelegramCommandEntry({
      name: 'fix',
      description: 'Investigate and fix an issue',
      mode: 'llm',
      template: 'Command:\n{{args}}',
    })

    expect(renderTelegramCommandPrompt(command, 'please repair the parser')).toBe('Command:\nplease repair the parser')
  })

  it('parses slash commands with optional bot names', () => {
    expect(parseTelegramSlashCommand('/fix broken parser')).toEqual({
      name: 'fix',
      args: 'broken parser',
    })
    expect(parseTelegramSlashCommand('/daily@my_bot')).toEqual({
      name: 'daily',
      args: '',
    })
    expect(parseTelegramSlashCommand('/self-improve inspect memory')).toEqual({
      name: 'self-improve',
      args: 'inspect memory',
    })
    expect(parseTelegramSlashCommand('hello /fix')).toBeUndefined()
  })

  it('builds bot command metadata from the registry', () => {
    const commands = buildTelegramBotCommands([
      ...defaultTelegramCommandRegistry().commands,
      normalizeTelegramCommandEntry({
        name: 'self-improve',
        description: 'Improve the assistant from recent work',
        mode: 'llm',
        template: 'Improve: {{args}}',
      }),
    ])

    expect(commands).toEqual([
      { command: 'start', description: 'Welcome and setup guide' },
      { command: 'help', description: 'What this bot can do' },
      { command: 'status', description: 'Check your pairing status' },
      { command: 'commands', description: 'List available commands' },
      { command: 'usage', description: 'Show viberelay usage' },
      { command: 'fix', description: 'Investigate and fix an issue' },
      { command: 'build', description: 'Plan or implement a feature' },
      { command: 'daily', description: 'Prepare a daily summary' },
    ])
  })

  it('loads direct command handlers from command files', async () => {
    const handler = await loadDirectCommandHandler('commands')

    expect(handler).toBeDefined()
    expect(await handler!({
      args: '',
      access: { allowFrom: ['123'], pending: {} },
      senderId: '123',
      registry: defaultTelegramCommandRegistry().commands,
    })).toEqual({
      text: [
        'Available commands:',
        '/start — Welcome and setup guide',
        '/help — What this bot can do',
        '/status — Check your pairing status',
        '/commands — List available commands',
        '/usage — Show viberelay usage',
        '/fix — Investigate and fix an issue',
        '/build — Plan or implement a feature',
        '/daily — Prepare a daily summary',
      ].join('\n'),
    })
  })
})
