import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRepo, openMemoryDb, relayMindPaths } from '@viberelay/shared/relaymind'
import dailyCommand from '../src/commands/relaymind/daily.js'

let workspace: string
let cwd: string

beforeEach(async () => {
  cwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-daily-'))
  process.chdir(workspace)
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(workspace, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function freshRepo() {
  const paths = relayMindPaths(workspace)
  const db = openMemoryDb(paths.memoryDb)
  const repo = new MemoryRepo(db)
  return { db, repo, paths }
}

describe('daily summarize (deterministic aggregation)', () => {
  it('writes a markdown file for today and indexes a daily_summary item', async () => {
    const { db, repo, paths } = freshRepo()
    const today = new Date().toISOString().slice(0, 10)

    // Seed some items for today.
    repo.addItem({ type: 'task', title: 'Wire memory CLI', body: 'Implemented mem add/search', day: today })
    repo.addItem({ type: 'decision', title: 'No embeddings in MVP', body: 'SQLite FTS5 only', day: today })
    repo.addItem({ type: 'open_loop', title: 'Daily summary scheduling', body: 'Decide fixed time vs idle trigger', day: today })
    db.close()

    const result = await dailyCommand(['summarize'], 'http://127.0.0.1:0')
    expect(result).toContain(today)

    // File exists.
    const filePath = join(paths.dailyDir, `${today}.md`)
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain(`# Daily Summary — ${today}`)
    expect(content).toContain('## Done')
    expect(content).toContain('Wire memory CLI')
    expect(content).toContain('## Decisions')
    expect(content).toContain('No embeddings in MVP')
    expect(content).toContain('## Open Loops')
    expect(content).toContain('Daily summary scheduling')

    // daily_summary item is FTS-indexed.
    const db2 = openMemoryDb(paths.memoryDb)
    try {
      const repo2 = new MemoryRepo(db2)
      const hits = repo2.search({ query: 'Daily Summary', types: ['daily_summary'] })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].item.type).toBe('daily_summary')
      expect(hits[0].item.day).toBe(today)
    } finally {
      db2.close()
    }
  })

  it('respects --date flag and writes to the correct file', async () => {
    const { db, repo, paths } = freshRepo()
    const targetDate = '2026-01-15'

    repo.addItem({ type: 'memory', title: 'Old note', body: 'worked on something', day: targetDate })
    db.close()

    const result = await dailyCommand(['summarize', '--date', targetDate], '')
    expect(result).toContain(targetDate)

    const filePath = join(paths.dailyDir, `${targetDate}.md`)
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain(`# Daily Summary — ${targetDate}`)
    expect(content).toContain('Old note')
  })

  it('does not self-reference existing daily_summary items', async () => {
    const { db, repo, paths } = freshRepo()
    const today = new Date().toISOString().slice(0, 10)

    repo.addItem({
      type: 'daily_summary',
      title: `Daily Summary — ${today}`,
      body: '# Daily Summary — old',
      day: today,
    })
    db.close()

    await dailyCommand(['summarize'], '')
    const filePath = join(paths.dailyDir, `${today}.md`)
    const content = await readFile(filePath, 'utf8')
    // The old daily_summary item should not appear in the Done section.
    expect(content).not.toContain('Daily Summary — old')
  })

  it('throws on invalid --date format', async () => {
    await expect(dailyCommand(['summarize', '--date', 'not-a-date'], '')).rejects.toThrow(/YYYY-MM-DD/)
  })
})

describe('daily summarize --from-stdin', () => {
  it('stores pre-built markdown from stdin and FTS-indexes it', async () => {
    const { paths } = freshRepo()
    const date = '2026-03-10'
    const markdown = `# Daily Summary — ${date}\n\n## Done\n- Built the context render hook\n`

    // Pipe markdown through stdin.
    const { Readable } = await import('node:stream')
    const fakeStdin = Readable.from([markdown])
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(fakeStdin as typeof process.stdin)

    const result = await dailyCommand(['summarize', '--from-stdin'], '')
    expect(result).toContain(date)

    const filePath = join(paths.dailyDir, `${date}.md`)
    const content = await readFile(filePath, 'utf8')
    expect(content.trim()).toBe(markdown.trim())

    // FTS-indexed.
    const db = openMemoryDb(paths.memoryDb)
    try {
      const repo = new MemoryRepo(db)
      const hits = repo.search({ query: 'context render hook', types: ['daily_summary'] })
      expect(hits.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})

describe('daily show', () => {
  it('prints the summary file contents', async () => {
    const { paths } = freshRepo()
    const date = '2026-04-01'
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(paths.dailyDir, { recursive: true })
    await writeFile(join(paths.dailyDir, `${date}.md`), `# Daily Summary — ${date}\n\n## Done\n- stuff\n`, 'utf8')

    const result = await dailyCommand(['show', date], '')
    expect(result).toContain(`# Daily Summary — ${date}`)
    expect(result).toContain('stuff')
  })

  it('reports missing file gracefully', async () => {
    const result = await dailyCommand(['show', '2020-01-01'], '')
    expect(result).toContain('no daily summary')
    expect(result).toContain('2020-01-01')
  })
})

describe('daily search', () => {
  it('searches daily_summary items by FTS query', async () => {
    const { db, repo } = freshRepo()
    repo.addItem({
      type: 'daily_summary',
      title: 'Daily Summary — 2026-04-01',
      body: '# Daily Summary\n## Done\n- implemented the memory pipeline',
      day: '2026-04-01',
    })
    db.close()

    const result = await dailyCommand(['search', 'memory pipeline'], '')
    expect(result).toContain('Daily Summary')
  })

  it('throws when no query is provided', async () => {
    await expect(dailyCommand(['search'], '')).rejects.toThrow(/query/)
  })
})

describe('daily unknown subcommand', () => {
  it('throws on unknown subcommand', async () => {
    await expect(dailyCommand(['nope'], '')).rejects.toThrow(/unknown daily subcommand/)
  })
})
