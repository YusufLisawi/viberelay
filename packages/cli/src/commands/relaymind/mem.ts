/**
 * `viberelay relaymind mem <subcommand>` — memory CRUD/search CLI.
 *
 * Subcommands: add, search, get, update, delete, link, related.
 * `--json` switches to machine-readable output. Bad args throw — the
 * registrar surfaces `.message`.
 */
import process from 'node:process'
import {
  MemoryRepo,
  openMemoryDb,
  relayMindPaths,
  type MemoryEdgeRel,
  type MemoryItem,
  type MemoryItemType,
  type MemorySearchHit,
} from '@viberelay/shared/relaymind'
import type { Database } from 'bun:sqlite'

interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const key = a.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function flagStr(flags: ParsedArgs['flags'], key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function flagBool(flags: ParsedArgs['flags'], key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

function flagInt(flags: ParsedArgs['flags'], key: string): number | undefined {
  const v = flagStr(flags, key)
  if (v === undefined) return undefined
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) throw new Error(`--${key} must be an integer`)
  return n
}

function requiredStr(flags: ParsedArgs['flags'], key: string): string {
  const v = flagStr(flags, key)
  if (!v) throw new Error(`--${key} is required`)
  return v
}

function parseId(raw: string | undefined, label = 'id'): number {
  if (!raw) throw new Error(`${label} is required`)
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive integer`)
  return n
}

function withRepo<T>(allowSecrets: boolean, fn: (repo: MemoryRepo, db: Database) => T): T {
  const paths = relayMindPaths(process.cwd())
  const db = openMemoryDb(paths.memoryDb)
  try {
    const repo = new MemoryRepo(db, { allowSecrets })
    return fn(repo, db)
  } finally {
    db.close()
  }
}

function fmtItem(it: MemoryItem): string {
  return `[${it.id}] ${it.type.padEnd(13)} ${it.day} ${it.title}`
}

function fmtItemFull(it: MemoryItem): string {
  const lines = [
    `id: ${it.id}`,
    `type: ${it.type}`,
    `title: ${it.title}`,
    `day: ${it.day}`,
    `importance: ${it.importance}`,
    `source: ${it.source ?? '-'}`,
    `created_at: ${it.createdAt}`,
    `updated_at: ${it.updatedAt}`,
    '',
    it.body,
  ]
  return lines.join('\n')
}

function fmtHit(h: MemorySearchHit): string {
  const score = h.score.toFixed(3)
  const via = h.via && h.via.length > 0 ? ` via=${h.via.map(e => e.rel).join(',')}` : ''
  return `${score}  ${fmtItem(h.item)}${via}`
}

// ── subcommands ──────────────────────────────────────────────────────────────

function cmdAdd(args: ParsedArgs): string {
  const type = requiredStr(args.flags, 'type') as MemoryItemType
  const title = requiredStr(args.flags, 'title')
  const body = requiredStr(args.flags, 'body')
  const source = flagStr(args.flags, 'source')
  const importance = flagInt(args.flags, 'importance')
  const day = flagStr(args.flags, 'day')
  const json = flagBool(args.flags, 'json')
  const allowSecrets = flagBool(args.flags, 'allow-secrets')

  return withRepo(allowSecrets, repo => {
    const item = repo.addItem({ type, title, body, source, importance, day })
    if (json) return JSON.stringify(item)
    return `added ${fmtItem(item)}`
  })
}

function cmdSearch(args: ParsedArgs): string {
  const query = args.positional.join(' ').trim()
  if (!query) throw new Error('search requires a query')
  const limit = flagInt(args.flags, 'limit') ?? 20
  const types = flagStr(args.flags, 'type')
  const expand = flagBool(args.flags, 'expand-edges')
  const json = flagBool(args.flags, 'json')

  return withRepo(false, repo => {
    const hits = repo.search({
      query,
      limit,
      types: types ? (types.split(',') as MemoryItemType[]) : undefined,
      expandEdges: expand,
    })
    if (json) return JSON.stringify(hits)
    if (hits.length === 0) return 'no matches'
    return hits.map(fmtHit).join('\n')
  })
}

function cmdGet(args: ParsedArgs): string {
  const ids = args.positional.map(p => parseId(p))
  if (ids.length === 0) throw new Error('get requires at least one id')
  const json = flagBool(args.flags, 'json')

  return withRepo(false, repo => {
    const items = repo.getItems(ids)
    if (json) return JSON.stringify(items)
    if (items.length === 0) return 'no items'
    return items.map(fmtItemFull).join('\n\n---\n\n')
  })
}

function cmdUpdate(args: ParsedArgs): string {
  const id = parseId(args.positional[0])
  const json = flagBool(args.flags, 'json')
  const allowSecrets = flagBool(args.flags, 'allow-secrets')
  const patch: Parameters<MemoryRepo['updateItem']>[1] = {}
  const title = flagStr(args.flags, 'title')
  if (title !== undefined) patch.title = title
  const body = flagStr(args.flags, 'body')
  if (body !== undefined) patch.body = body
  const source = flagStr(args.flags, 'source')
  if (source !== undefined) patch.source = source
  const day = flagStr(args.flags, 'day')
  if (day !== undefined) patch.day = day
  const importance = flagInt(args.flags, 'importance')
  if (importance !== undefined) patch.importance = importance
  const type = flagStr(args.flags, 'type')
  if (type !== undefined) patch.type = type as MemoryItemType
  if (Object.keys(patch).length === 0) throw new Error('update requires at least one field')

  return withRepo(allowSecrets, repo => {
    const item = repo.updateItem(id, patch)
    if (json) return JSON.stringify(item)
    return `updated ${fmtItem(item)}`
  })
}

function cmdDelete(args: ParsedArgs): string {
  const id = parseId(args.positional[0])
  const json = flagBool(args.flags, 'json')
  return withRepo(false, repo => {
    const ok = repo.deleteItem(id)
    if (json) return JSON.stringify({ id, deleted: ok })
    return ok ? `deleted ${id}` : `no item with id ${id}`
  })
}

function cmdLink(args: ParsedArgs): string {
  const fromId = parseId(args.positional[0], 'from')
  const toId = parseId(args.positional[1], 'to')
  const rel = requiredStr(args.flags, 'rel') as MemoryEdgeRel
  const weight = flagInt(args.flags, 'weight')
  const json = flagBool(args.flags, 'json')
  return withRepo(false, repo => {
    const edge = repo.addEdge({ fromId, toId, rel, weight })
    if (json) return JSON.stringify(edge)
    return `linked ${fromId} -[${edge.rel}/${edge.weight}]-> ${toId}`
  })
}

function cmdRelated(args: ParsedArgs): string {
  const id = parseId(args.positional[0])
  const json = flagBool(args.flags, 'json')
  return withRepo(false, repo => {
    const rows = repo.related(id)
    if (json) return JSON.stringify(rows)
    if (rows.length === 0) return 'no related items'
    return rows.map(({ item, edge }) => `[${edge.rel}] ${fmtItem(item)}`).join('\n')
  })
}

// ── entry ────────────────────────────────────────────────────────────────────

const HELP = `viberelay relaymind mem <subcommand>

  add       --type T --title T --body T [--source S] [--importance N] [--day YYYY-MM-DD] [--allow-secrets]
  search    "<query>" [--limit N] [--type T,T] [--expand-edges]
  get       <id> [...ids]
  update    <id> [--title T] [--body T] [--importance N] [--type T] [--day D] [--source S] [--allow-secrets]
  delete    <id>
  link      <from> <to> --rel R [--weight N]
  related   <id>

Add --json to any subcommand for machine-readable output.`

const HANDLERS: Record<string, (args: ParsedArgs) => string> = {
  add: cmdAdd,
  search: cmdSearch,
  get: cmdGet,
  update: cmdUpdate,
  delete: cmdDelete,
  link: cmdLink,
  related: cmdRelated,
}

export default async function memCommand(argv: string[], _baseUrl: string): Promise<string> {
  void _baseUrl
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return HELP
  const handler = HANDLERS[sub]
  if (!handler) throw new Error(`unknown mem subcommand: ${sub}\n\n${HELP}`)
  return handler(parseArgs(argv.slice(1)))
}
