/**
 * Typed repository over the RelayMind memory database.
 *
 * Returns the shapes declared in `../types.ts` — that file is the contract.
 * Search ranks via SQLite FTS5 BM25 with recency + importance boosts and
 * normalizes the result to a 0..1 score (higher = more relevant).
 */
import type { Database } from 'bun:sqlite'
import type {
  MemoryAddInput,
  MemoryEdge,
  MemoryEdgeRel,
  MemoryItem,
  MemoryItemType,
  MemorySearchHit,
  MemorySearchOptions,
} from '../types.js'

interface ItemRow {
  id: number
  type: string
  title: string
  body: string
  source: string | null
  day: string
  importance: number
  created_at: string
  updated_at: string
}

interface EdgeRow {
  from_id: number
  to_id: number
  rel: string
  weight: number
  created_at: string
}

interface SearchRow extends ItemRow {
  rank: number
}

const ITEM_TYPES = new Set<MemoryItemType>([
  'memory',
  'preference',
  'decision',
  'checkpoint',
  'daily_summary',
  'task',
  'idea',
  'bug',
  'open_loop',
])

const EDGE_RELS = new Set<MemoryEdgeRel>([
  'same_task',
  'followup',
  'depends_on',
  'mentioned_in',
  'decision_of',
  'supersedes',
  'caused_by',
])

function rowToItem(r: ItemRow): MemoryItem {
  return {
    id: r.id,
    type: r.type as MemoryItemType,
    title: r.title,
    body: r.body,
    source: r.source,
    day: r.day,
    importance: r.importance,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToEdge(r: EdgeRow): MemoryEdge {
  return {
    fromId: r.from_id,
    toId: r.to_id,
    rel: r.rel as MemoryEdgeRel,
    weight: r.weight,
    createdAt: r.created_at,
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowIso(): string {
  return new Date().toISOString()
}

function assertItemType(t: string): asserts t is MemoryItemType {
  if (!ITEM_TYPES.has(t as MemoryItemType)) {
    throw new Error(`invalid memory item type: ${t}`)
  }
}

function assertEdgeRel(r: string): asserts r is MemoryEdgeRel {
  if (!EDGE_RELS.has(r as MemoryEdgeRel)) {
    throw new Error(`invalid edge relation: ${r}`)
  }
}

/**
 * Refuse bodies that look like they contain plaintext secrets. Spec from the
 * agent brief: a key/value pair on a single line where the key matches
 * api_key/secret/token/password and the value is a long opaque string.
 */
const SECRET_RE = /(?:^|\n)\s*\S*(api[_-]?key|secret|token|password)\S*\s*[:=]\s*['"]?([^\s'"]{12,})['"]?/i

export interface SecretRedactionResult {
  redacted: boolean
  match?: string
}

export function detectSecret(body: string): SecretRedactionResult {
  const m = SECRET_RE.exec(body)
  if (!m) return { redacted: false }
  return { redacted: true, match: m[0].trim() }
}

export interface MemoryRepoOptions {
  /** Skip secrets redaction when true. Off by default. */
  allowSecrets?: boolean
}

export class MemoryRepo {
  constructor(
    private readonly db: Database,
    private readonly options: MemoryRepoOptions = {},
  ) {}

  // ── items ──────────────────────────────────────────────────────────────────

  addItem(input: MemoryAddInput): MemoryItem {
    assertItemType(input.type)
    if (!input.title.trim()) throw new Error('title is required')
    if (!this.options.allowSecrets) {
      const s = detectSecret(input.body)
      if (s.redacted) {
        throw new Error(
          `refusing to store memory: body looks like a secret (${s.match}). pass --allow-secrets to override.`,
        )
      }
    }
    const now = nowIso()
    const day = input.day ?? todayUtc()
    const importance = input.importance ?? 0
    const stmt = this.db.prepare<ItemRow>(`
      INSERT INTO items(type, title, body, source, day, importance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `)
    const row = stmt.get(
      input.type,
      input.title,
      input.body,
      input.source ?? null,
      day,
      importance,
      now,
      now,
    )
    if (!row) throw new Error('insert failed')
    return rowToItem(row)
  }

  getItem(id: number): MemoryItem | null {
    const row = this.db.prepare<ItemRow>(`SELECT * FROM items WHERE id = ?`).get(id)
    return row ? rowToItem(row) : null
  }

  getItems(ids: number[]): MemoryItem[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare<ItemRow>(`SELECT * FROM items WHERE id IN (${placeholders}) ORDER BY id ASC`)
      .all(...ids)
    return rows.map(rowToItem)
  }

  updateItem(
    id: number,
    patch: Partial<Pick<MemoryItem, 'title' | 'body' | 'importance' | 'source' | 'type' | 'day'>>,
  ): MemoryItem {
    const current = this.getItem(id)
    if (!current) throw new Error(`item ${id} not found`)
    if (patch.type) assertItemType(patch.type)
    if (patch.body !== undefined && !this.options.allowSecrets) {
      const s = detectSecret(patch.body)
      if (s.redacted) {
        throw new Error(
          `refusing to update memory: body looks like a secret (${s.match}). pass --allow-secrets to override.`,
        )
      }
    }
    const next: MemoryItem = {
      ...current,
      ...patch,
      source: patch.source !== undefined ? patch.source : current.source,
      updatedAt: nowIso(),
    }
    this.db
      .prepare(
        `UPDATE items SET type=?, title=?, body=?, source=?, day=?, importance=?, updated_at=? WHERE id=?`,
      )
      .run(next.type, next.title, next.body, next.source, next.day, next.importance, next.updatedAt, id)
    return next
  }

  deleteItem(id: number): boolean {
    const res = this.db.prepare(`DELETE FROM items WHERE id = ?`).run(id)
    return res.changes > 0
  }

  // ── edges ──────────────────────────────────────────────────────────────────

  addEdge(input: { fromId: number; toId: number; rel: MemoryEdgeRel; weight?: number }): MemoryEdge {
    assertEdgeRel(input.rel)
    if (input.fromId === input.toId) throw new Error('edge endpoints must differ')
    const now = nowIso()
    const weight = input.weight ?? 1
    this.db
      .prepare(
        `INSERT INTO edges(from_id, to_id, rel, weight, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(from_id, to_id, rel) DO UPDATE SET weight = excluded.weight`,
      )
      .run(input.fromId, input.toId, input.rel, weight, now)
    return { fromId: input.fromId, toId: input.toId, rel: input.rel, weight, createdAt: now }
  }

  /** One-hop neighbors of `id`, in either direction. */
  related(id: number): { item: MemoryItem; edge: MemoryEdge }[] {
    const rows = this.db
      .prepare<EdgeRow & { neighbor_id: number }>(
        `SELECT e.*, CASE WHEN e.from_id = ?1 THEN e.to_id ELSE e.from_id END AS neighbor_id
         FROM edges e
         WHERE e.from_id = ?1 OR e.to_id = ?1`,
      )
      .all(id)
    if (rows.length === 0) return []
    const neighborIds = rows.map(r => r.neighbor_id)
    const items = new Map(this.getItems(neighborIds).map(i => [i.id, i]))
    const out: { item: MemoryItem; edge: MemoryEdge }[] = []
    for (const r of rows) {
      const item = items.get(r.neighbor_id)
      if (item) out.push({ item, edge: rowToEdge(r) })
    }
    return out
  }

  // ── search ─────────────────────────────────────────────────────────────────

  search(opts: MemorySearchOptions): MemorySearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200))
    const recency = opts.recency !== false
    const ftsQuery = sanitizeFtsQuery(opts.query)
    if (!ftsQuery) return []

    let sql = `
      SELECT items.*, bm25(items_fts) AS rank
      FROM items_fts
      JOIN items ON items.id = items_fts.rowid
      WHERE items_fts MATCH ?
    `
    const params: (string | number)[] = [ftsQuery]
    if (opts.types && opts.types.length > 0) {
      sql += ` AND items.type IN (${opts.types.map(() => '?').join(',')})`
      params.push(...opts.types)
    }
    sql += ` ORDER BY rank ASC LIMIT ?`
    params.push(limit * 4) // overfetch for re-rank

    const rows = this.db.prepare<SearchRow>(sql).all(...params)
    if (rows.length === 0) return []

    const today = Date.now()
    const queryLower = opts.query.toLowerCase()

    const scored = rows.map(r => {
      const item = rowToItem(r)
      // bm25 in SQLite FTS5 is a non-negative cost (lower=better). Map to 0..1.
      const ftsScore = 1 / (1 + Math.max(0, r.rank))
      let score = ftsScore

      // exact phrase / title boost
      if (item.title.toLowerCase().includes(queryLower)) score += 0.15
      else if (item.body.toLowerCase().includes(queryLower)) score += 0.05

      // recency: half-life ~30 days
      if (recency) {
        const ts = Date.parse(item.updatedAt)
        if (!Number.isNaN(ts)) {
          const days = Math.max(0, (today - ts) / (1000 * 60 * 60 * 24))
          score += 0.15 * Math.exp(-days / 30)
        }
      }

      // importance: each level worth ~0.05, capped at 0.25
      score += Math.min(0.25, Math.max(0, item.importance) * 0.05)

      return { item, score: Math.min(1, score) } satisfies MemorySearchHit
    })

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // tie-break: importance, then recency
      if (b.item.importance !== a.item.importance) return b.item.importance - a.item.importance
      return Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt)
    })

    const top = scored.slice(0, limit)

    if (!opts.expandEdges) return top

    // one-hop edge expansion: append related items not already in `top`.
    const seen = new Set(top.map(h => h.item.id))
    const expanded: MemorySearchHit[] = [...top]
    for (const hit of top) {
      const neighbors = this.related(hit.item.id)
      for (const { item, edge } of neighbors) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        expanded.push({ item, score: hit.score * 0.5, via: [edge] })
        if (expanded.length >= limit * 2) break
      }
      if (expanded.length >= limit * 2) break
    }
    return expanded
  }
}

/**
 * Escape user input so it works as an FTS5 query. We wrap each non-empty term
 * in double-quotes (FTS5 phrase syntax) and OR them — this avoids syntax
 * errors on punctuation and gives sensible recall for free-form input.
 */
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map(t => t.replace(/["]/g, '').trim())
    .filter(t => t.length > 0)
  if (terms.length === 0) return ''
  return terms.map(t => `"${t}"`).join(' OR ')
}
