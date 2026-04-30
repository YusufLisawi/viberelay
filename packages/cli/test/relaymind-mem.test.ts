import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRepo, openMemoryDb } from '@viberelay/shared/relaymind'
import memCommand from '../src/commands/relaymind/mem.js'

let workspace: string
let cwd: string

beforeEach(async () => {
  cwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-mem-'))
  process.chdir(workspace)
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(workspace, { recursive: true, force: true })
})

function freshRepo() {
  const dbPath = join(workspace, '.relaymind', 'relaymind.db')
  const db = openMemoryDb(dbPath)
  const repo = new MemoryRepo(db)
  return { db, repo }
}

describe('memory repo', () => {
  it('round-trips add/get and indexes for FTS search', () => {
    const { db, repo } = freshRepo()
    try {
      const item = repo.addItem({
        type: 'decision',
        title: 'Use editable Telegram command registry',
        body: 'Manifest reload is hot, handler reload requires plugin restart.',
        source: 'docs/relaymind/DECISIONS.md',
        importance: 3,
      })
      expect(item.id).toBeGreaterThan(0)
      expect(item.createdAt).toMatch(/T/)

      const fetched = repo.getItem(item.id)
      expect(fetched).toEqual(item)

      const hits = repo.search({ query: 'Telegram command registry' })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].item.id).toBe(item.id)
      expect(hits[0].score).toBeGreaterThan(0)
      expect(hits[0].score).toBeLessThanOrEqual(1)
    } finally {
      db.close()
    }
  })

  it('matches FTS phrases inside item bodies and across types', () => {
    const { db, repo } = freshRepo()
    try {
      const a = repo.addItem({ type: 'idea', title: 'Direct commands bypass LLM', body: 'Slash commands run locally.' })
      repo.addItem({ type: 'memory', title: 'Unrelated note', body: 'about cats' })
      const c = repo.addItem({ type: 'daily_summary', title: 'Daily', body: 'Worked on slash commands today.' })

      const phraseHits = repo.search({ query: 'slash commands' })
      const ids = phraseHits.map(h => h.item.id)
      expect(ids).toContain(a.id)
      expect(ids).toContain(c.id)

      const filtered = repo.search({ query: 'commands', types: ['daily_summary'] })
      expect(filtered.every(h => h.item.type === 'daily_summary')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('expands one-hop edges via related and search expandEdges', () => {
    const { db, repo } = freshRepo()
    try {
      const a = repo.addItem({ type: 'task', title: 'Wire memory CLI', body: 'mem add/search/get' })
      const b = repo.addItem({ type: 'decision', title: 'No embeddings in MVP', body: 'SQLite FTS5 only.' })
      repo.addEdge({ fromId: a.id, toId: b.id, rel: 'depends_on' })

      const related = repo.related(a.id)
      expect(related).toHaveLength(1)
      expect(related[0].item.id).toBe(b.id)
      expect(related[0].edge.rel).toBe('depends_on')

      const expanded = repo.search({ query: 'memory CLI', expandEdges: true })
      const ids = expanded.map(h => h.item.id)
      expect(ids).toContain(a.id)
      expect(ids).toContain(b.id)
      const viaHit = expanded.find(h => h.item.id === b.id)
      expect(viaHit?.via?.[0]?.rel).toBe('depends_on')
    } finally {
      db.close()
    }
  })

  it('orders ties by importance', () => {
    const { db, repo } = freshRepo()
    try {
      const low = repo.addItem({ type: 'memory', title: 'alpha note', body: 'alpha alpha', importance: 0 })
      const high = repo.addItem({ type: 'memory', title: 'alpha note', body: 'alpha alpha', importance: 5 })
      const hits = repo.search({ query: 'alpha', recency: false })
      expect(hits[0].item.id).toBe(high.id)
      expect(hits[1].item.id).toBe(low.id)
    } finally {
      db.close()
    }
  })

  it('refuses to store secrets unless allow-secrets is set', () => {
    const { db, repo } = freshRepo()
    try {
      expect(() =>
        repo.addItem({
          type: 'memory',
          title: 'leaked',
          body: 'api_key = sk-abcdefghijklmnopqrstuvwxyz12345',
        }),
      ).toThrow(/secret/i)

      const allowing = new MemoryRepo(db, { allowSecrets: true })
      const ok = allowing.addItem({
        type: 'memory',
        title: 'allowed',
        body: 'api_key = sk-abcdefghijklmnopqrstuvwxyz12345',
      })
      expect(ok.id).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('updates and deletes propagate to FTS', () => {
    const { db, repo } = freshRepo()
    try {
      const item = repo.addItem({ type: 'memory', title: 'original title', body: 'foo' })
      repo.updateItem(item.id, { title: 'changed banana title' })
      const hits = repo.search({ query: 'banana' })
      expect(hits[0]?.item.id).toBe(item.id)

      const original = repo.search({ query: 'original' })
      expect(original.find(h => h.item.id === item.id)).toBeUndefined()

      expect(repo.deleteItem(item.id)).toBe(true)
      const after = repo.search({ query: 'banana' })
      expect(after.find(h => h.item.id === item.id)).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

describe('mem CLI', () => {
  it('add + search + get round trip via the CLI handler', async () => {
    const addOut = await memCommand(
      ['add', '--type', 'decision', '--title', 'CLI works', '--body', 'banana split flow', '--json'],
      'http://127.0.0.1:0',
    )
    const item = JSON.parse(addOut) as { id: number; title: string }
    expect(item.id).toBeGreaterThan(0)

    const searchOut = await memCommand(['search', 'banana', '--json'], 'http://127.0.0.1:0')
    const hits = JSON.parse(searchOut) as { item: { id: number } }[]
    expect(hits[0].item.id).toBe(item.id)

    const getOut = await memCommand(['get', String(item.id), '--json'], 'http://127.0.0.1:0')
    const items = JSON.parse(getOut) as { id: number; title: string }[]
    expect(items[0].title).toBe('CLI works')
  })

  it('rejects bad subcommand and missing required flags', async () => {
    await expect(memCommand(['nope'], '')).rejects.toThrow(/unknown mem subcommand/)
    await expect(memCommand(['add', '--type', 'memory'], '')).rejects.toThrow(/--title/)
  })

  it('link + related expose edges', async () => {
    const a = JSON.parse(
      await memCommand(['add', '--type', 'task', '--title', 'A', '--body', 'a body', '--json'], ''),
    ) as { id: number }
    const b = JSON.parse(
      await memCommand(['add', '--type', 'task', '--title', 'B', '--body', 'b body', '--json'], ''),
    ) as { id: number }

    await memCommand(['link', String(a.id), String(b.id), '--rel', 'followup'], '')
    const out = await memCommand(['related', String(a.id), '--json'], '')
    const rows = JSON.parse(out) as { item: { id: number }; edge: { rel: string } }[]
    expect(rows[0].item.id).toBe(b.id)
    expect(rows[0].edge.rel).toBe('followup')
  })
})
