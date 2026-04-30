import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRepo, openMemoryDb, relayMindPaths } from '@viberelay/shared/relaymind'
import checkpointCommand from '../src/commands/relaymind/checkpoint.js'

let workspace: string
let cwd: string

beforeEach(async () => {
  cwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-checkpoint-'))
  process.chdir(workspace)
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(workspace, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function paths() {
  return relayMindPaths(workspace)
}

describe('checkpoint write + latest round-trip', () => {
  it('stores a checkpoint item and returns it via latest', async () => {
    const writeResult = await checkpointCommand(
      ['write', '--title', 'End of session checkpoint', '--body', '## What happened\nFixed the memory pipeline.'],
      '',
    )
    expect(writeResult).toContain('checkpoint')
    expect(writeResult).toContain('End of session checkpoint')

    const latestResult = await checkpointCommand(['latest'], '')
    expect(latestResult).toContain('End of session checkpoint')
    expect(latestResult).toContain('Fixed the memory pipeline')
  })

  it('stores checkpoint as type=checkpoint in SQLite', async () => {
    await checkpointCommand(
      ['write', '--title', 'Pre-refactor', '--body', 'About to do a big refactor.'],
      '',
    )

    const p = paths()
    const db = openMemoryDb(p.memoryDb)
    try {
      const repo = new MemoryRepo(db)
      const hits = repo.search({ query: 'Pre-refactor', types: ['checkpoint'] })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].item.type).toBe('checkpoint')
      expect(hits[0].item.title).toBe('Pre-refactor')
    } finally {
      db.close()
    }
  })

  it('latest returns most recent when multiple checkpoints exist', async () => {
    await checkpointCommand(['write', '--title', 'First checkpoint', '--body', 'First body'], '')
    await checkpointCommand(['write', '--title', 'Second checkpoint', '--body', 'Second body'], '')

    const result = await checkpointCommand(['latest'], '')
    expect(result).toContain('Second checkpoint')
    expect(result).not.toContain('First checkpoint')
  })

  it('latest returns a friendly message when no checkpoints exist', async () => {
    // Ensure DB is initialized (open and close).
    const p = paths()
    const db = openMemoryDb(p.memoryDb)
    db.close()

    const result = await checkpointCommand(['latest'], '')
    expect(result).toContain('no checkpoints found')
  })
})

describe('checkpoint write --from-stdin', () => {
  it('reads body from stdin', async () => {
    const body = '## What happened\nCompleted context render hook implementation.'
    const { Readable } = await import('node:stream')
    const fakeStdin = Readable.from([body])
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(fakeStdin as typeof process.stdin)

    const result = await checkpointCommand(['write', '--title', 'Hook implementation', '--from-stdin'], '')
    expect(result).toContain('Hook implementation')

    const latest = await checkpointCommand(['latest'], '')
    expect(latest).toContain('Completed context render hook implementation')
  })
})

describe('checkpoint maybe — flag behavior', () => {
  it('returns "no checkpoint needed" when flag is absent', async () => {
    // Ensure supervisor state dir exists but no flag file.
    const p = paths()
    await mkdir(p.supervisorStateDir, { recursive: true })

    const result = await checkpointCommand(['maybe'], '')
    expect(result).toBe('no checkpoint needed')
  })

  it('returns "checkpoint-needed" when flag file exists', async () => {
    const p = paths()
    await mkdir(p.supervisorStateDir, { recursive: true })
    const flagPath = join(p.supervisorStateDir, 'checkpoint-needed')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(flagPath, 'pre-compact\n', 'utf8')

    const result = await checkpointCommand(['maybe'], '')
    expect(result).toBe('checkpoint-needed')
  })

  it('checkpoint write clears the flag file', async () => {
    const p = paths()
    await mkdir(p.supervisorStateDir, { recursive: true })
    const flagPath = join(p.supervisorStateDir, 'checkpoint-needed')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(flagPath, 'stop\n', 'utf8')

    // Confirm flag exists before write.
    expect(await checkpointCommand(['maybe'], '')).toBe('checkpoint-needed')

    await checkpointCommand(['write', '--title', 'Clears flag', '--body', 'Body text.'], '')

    // Flag should be gone.
    await expect(stat(flagPath)).rejects.toThrow()
    expect(await checkpointCommand(['maybe'], '')).toBe('no checkpoint needed')
  })
})

describe('checkpoint validation', () => {
  it('throws when --title is missing on write', async () => {
    await expect(checkpointCommand(['write', '--body', 'some body'], '')).rejects.toThrow(/--title/)
  })

  it('throws when --body is missing (no --from-stdin) on write', async () => {
    await expect(checkpointCommand(['write', '--title', 'Test'], '')).rejects.toThrow(/--body/)
  })

  it('throws on unknown subcommand', async () => {
    await expect(checkpointCommand(['nope'], '')).rejects.toThrow(/unknown checkpoint subcommand/)
  })
})
