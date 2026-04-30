import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRepo, openMemoryDb, relayMindPaths } from '@viberelay/shared/relaymind'
import type { ContextRenderOutput } from '@viberelay/shared/relaymind'
import contextCommand from '../src/commands/relaymind/context.js'

let workspace: string
let cwd: string

beforeEach(async () => {
  cwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-context-'))
  process.chdir(workspace)
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(workspace, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function seedContextFiles(paths: ReturnType<typeof relayMindPaths>) {
  await mkdir(paths.claudeHome, { recursive: true })
  await writeFile(paths.soulMd, '# SOUL\nI am RelayMind.\n', 'utf8')
  await writeFile(paths.toolsMd, '# TOOLS\nUse the CLI.\n', 'utf8')
  await writeFile(paths.memoryMd, '# MEMORY\nActive goals: none.\n', 'utf8')
}

function parseInternal(raw: string): ContextRenderOutput {
  return JSON.parse(raw) as ContextRenderOutput
}

interface ClaudeHookOutput {
  continue: boolean
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext: string
  }
}

function parseHook(raw: string): ClaudeHookOutput {
  return JSON.parse(raw) as ClaudeHookOutput
}

/** Pipe a string into process.stdin for the duration of the test. */
function mockStdin(content: string) {
  const { Readable } = require('node:stream') as typeof import('node:stream')
  const fakeStdin = Readable.from([content])
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(fakeStdin as typeof process.stdin)
}

describe('context render --event session-start (default = Claude hook shape)', () => {
  it('emits hookSpecificOutput with SOUL/TOOLS/MEMORY in additionalContext', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    const raw = await contextCommand(['render', '--event', 'session-start'], '')
    const out = parseHook(raw)

    expect(out.continue).toBe(true)
    expect(out.hookSpecificOutput).toBeDefined()
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart')
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('SOUL.md')
    expect(ctx).toContain('TOOLS.md')
    expect(ctx).toContain('MEMORY.md')
    expect(ctx).toContain('I am RelayMind.')
  })
})

describe('context render --internal-json (legacy programmatic shape)', () => {
  it('returns valid ContextRenderOutput JSON with SOUL/TOOLS/MEMORY headers', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    const raw = await contextCommand(
      ['render', '--event', 'session-start', '--internal-json'],
      '',
    )
    const out = parseInternal(raw)

    expect(out).toHaveProperty('text')
    expect(out).toHaveProperty('contextEstimate')
    expect(out).toHaveProperty('recommendation')
    expect(out.text).toContain('SOUL.md')
    expect(out.text).toContain('TOOLS.md')
    expect(out.text).toContain('MEMORY.md')
    expect(['low', 'medium', 'high', 'critical']).toContain(out.contextEstimate)
    expect(['continue', 'checkpoint-soon', 'checkpoint-now', 'avoid-large-reads']).toContain(out.recommendation)
  })
})

describe('context render --event user-prompt', () => {
  it('injects relevant memory search results for a matching prompt', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    // Seed a memory item that should match.
    const db = openMemoryDb(paths.memoryDb)
    try {
      const repo = new MemoryRepo(db)
      repo.addItem({
        type: 'decision',
        title: 'Use editable Telegram command registry',
        body: 'Manifest reload is hot, handler reload requires plugin restart.',
        importance: 3,
      })
    } finally {
      db.close()
    }

    const raw = await contextCommand(
      ['render', '--event', 'user-prompt', '--prompt', 'Telegram command registry', '--internal-json'],
      '',
    )
    const out = parseInternal(raw)

    expect(out.text).toContain('Relevant memory')
    expect(out.hitIds).toBeDefined()
    expect((out.hitIds ?? []).length).toBeGreaterThan(0)
  })

  it('does not include Relevant memory section when prompt has no matches', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    const raw = await contextCommand(
      ['render', '--event', 'user-prompt', '--prompt', 'xyzzy unreachable gobbledygook', '--internal-json'],
      '',
    )
    const out = parseInternal(raw)
    expect(out.text).not.toContain('Relevant memory')
    expect(out.hitIds).toBeUndefined()
  })

  it('default hook shape uses UserPromptSubmit hookEventName', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    const raw = await contextCommand(
      ['render', '--event', 'user-prompt', '--prompt', 'hello'],
      '',
    )
    const out = parseHook(raw)
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit')
    expect(out.hookSpecificOutput?.additionalContext).toContain('SOUL.md')
  })
})

describe('context render --event pre-compact', () => {
  it('emits checkpoint-needed flag file and recommendation=checkpoint-now (internal)', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)
    await mkdir(paths.supervisorStateDir, { recursive: true })

    const raw = await contextCommand(['render', '--event', 'pre-compact', '--internal-json'], '')
    const out = parseInternal(raw)

    expect(out.recommendation).toBe('checkpoint-now')

    const flagPath = join(paths.supervisorStateDir, 'checkpoint-needed')
    await expect(stat(flagPath)).resolves.toBeTruthy()
  })

  it('default shape: continue:true with NO hookSpecificOutput (no injection)', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)
    await mkdir(paths.supervisorStateDir, { recursive: true })

    const raw = await contextCommand(['render', '--event', 'pre-compact'], '')
    const out = parseHook(raw)
    expect(out.continue).toBe(true)
    expect(out.hookSpecificOutput).toBeUndefined()

    // Side effect must still happen.
    const flagPath = join(paths.supervisorStateDir, 'checkpoint-needed')
    await expect(stat(flagPath)).resolves.toBeTruthy()
  })
})

describe('context render --event stop', () => {
  it('emits checkpoint-needed flag file and recommendation=checkpoint-now (internal)', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)
    await mkdir(paths.supervisorStateDir, { recursive: true })

    const raw = await contextCommand(['render', '--event', 'stop', '--internal-json'], '')
    const out = parseInternal(raw)

    expect(out.recommendation).toBe('checkpoint-now')

    const flagPath = join(paths.supervisorStateDir, 'checkpoint-needed')
    await expect(stat(flagPath)).resolves.toBeTruthy()
  })

  it('default shape: continue:true with NO hookSpecificOutput', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)
    await mkdir(paths.supervisorStateDir, { recursive: true })

    const raw = await contextCommand(['render', '--event', 'stop'], '')
    const out = parseHook(raw)
    expect(out.continue).toBe(true)
    expect(out.hookSpecificOutput).toBeUndefined()
  })
})

describe('context render pressure tier classification', () => {
  it('classifies pressure correctly from transcript file size', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    const transcriptPath = join(workspace, 'transcript.txt')
    await writeFile(transcriptPath, 'x'.repeat(50 * 1024), 'utf8')

    const raw = await contextCommand(
      ['render', '--event', 'session-start', '--transcript-path', transcriptPath, '--internal-json'],
      '',
    )
    const out = parseInternal(raw)
    expect(out.contextEstimate).toBe('medium')
    expect(out.recommendation).toBe('continue')
  })

  it('classifies critical pressure for large transcript', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    const transcriptPath = join(workspace, 'big-transcript.txt')
    await writeFile(transcriptPath, 'x'.repeat(6 * 1024 * 1024), 'utf8')

    const raw = await contextCommand(
      ['render', '--event', 'session-start', '--transcript-path', transcriptPath, '--internal-json'],
      '',
    )
    const out = parseInternal(raw)
    expect(out.contextEstimate).toBe('critical')
    expect(out.recommendation).toBe('checkpoint-now')
  })
})

describe('context render --from-stdin', () => {
  it('reads kebab-case hook payload from stdin and returns hook shape', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    const payload = JSON.stringify({
      hook_event_name: 'session-start',
      session_id: 'test-session',
      cwd: workspace,
    })
    mockStdin(payload)

    const raw = await contextCommand(['render', '--from-stdin'], '')
    const out = parseHook(raw)

    expect(out.continue).toBe(true)
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput?.additionalContext).toContain('SOUL.md')
  })

  for (const [pascal, kebab] of [
    ['SessionStart', 'session-start'],
    ['UserPromptSubmit', 'user-prompt'],
    ['PreCompact', 'pre-compact'],
    ['Stop', 'stop'],
  ] as const) {
    it(`normalizes PascalCase event "${pascal}" → "${kebab}"`, async () => {
      const paths = relayMindPaths(workspace)
      await seedContextFiles(paths)
      await mkdir(paths.supervisorStateDir, { recursive: true })

      const payload = JSON.stringify({
        hook_event_name: pascal,
        session_id: 's',
        cwd: workspace,
      })
      mockStdin(payload)

      const raw = await contextCommand(['render', '--from-stdin'], '')
      const out = parseHook(raw)
      expect(out.continue).toBe(true)
      if (kebab === 'session-start' || kebab === 'user-prompt') {
        expect(out.hookSpecificOutput?.hookEventName).toBe(pascal)
        expect(out.hookSpecificOutput?.additionalContext).toContain('SOUL.md')
      } else {
        expect(out.hookSpecificOutput).toBeUndefined()
      }
    })
  }

  it('exits gracefully on malformed stdin JSON with continue:true', async () => {
    const paths = relayMindPaths(workspace)
    await seedContextFiles(paths)

    mockStdin('this is not json {{{')
    const raw = await contextCommand(['render', '--from-stdin'], '')
    const out = parseHook(raw)
    expect(out.continue).toBe(true)
    expect(out.hookSpecificOutput).toBeUndefined()
  })
})

describe('context render validation', () => {
  it('throws when --event is missing', async () => {
    await expect(contextCommand(['render'], '')).rejects.toThrow(/--event/)
  })

  it('throws on unknown --event value', async () => {
    await expect(contextCommand(['render', '--event', 'totally-invalid'], '')).rejects.toThrow(/must be one of/)
  })

  it('throws on unknown subcommand', async () => {
    await expect(contextCommand(['nope'], '')).rejects.toThrow(/unknown context subcommand/)
  })
})
