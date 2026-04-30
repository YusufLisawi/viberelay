/**
 * `viberelay relaymind daily <subcommand>` — daily summary management.
 *
 * Subcommands:
 *   summarize [--date YYYY-MM-DD]  — aggregate today's items into a markdown
 *                                     summary, write the file, and FTS-index it.
 *   summarize --from-stdin         — read pre-built summary markdown from stdin
 *                                     and store it (the path Claude uses).
 *   show [date]                    — print the summary for a date.
 *   search "<query>"               — FTS search over daily_summary items.
 *
 * No LLM calls. All logic is deterministic local aggregation.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { MemoryRepo, openMemoryDb, relayMindPaths } from '@viberelay/shared/relaymind'
import type { MemoryItem } from '@viberelay/shared/relaymind'

// ── helpers ───────────────────────────────────────────────────────────────────

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

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** Read all text from stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Atomic write: write to .tmp then rename. */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}

// ── summary builder ───────────────────────────────────────────────────────────

function groupItemsByType(items: MemoryItem[]): {
  done: MemoryItem[]
  decisions: MemoryItem[]
  openLoops: MemoryItem[]
  next: MemoryItem[]
} {
  const done: MemoryItem[] = []
  const decisions: MemoryItem[] = []
  const openLoops: MemoryItem[] = []
  const next: MemoryItem[] = []

  for (const item of items) {
    switch (item.type) {
      case 'task':
      case 'memory':
      case 'bug':
      case 'idea':
        done.push(item)
        break
      case 'decision':
      case 'preference':
        decisions.push(item)
        break
      case 'open_loop':
        openLoops.push(item)
        break
      case 'checkpoint':
        next.push(item)
        break
      case 'daily_summary':
        // skip — don't self-reference
        break
    }
  }
  return { done, decisions, openLoops, next }
}

function buildSummaryMarkdown(date: string, items: MemoryItem[]): string {
  const { done, decisions, openLoops, next } = groupItemsByType(items)

  function renderSection(title: string, list: MemoryItem[]): string {
    if (list.length === 0) return `## ${title}\n- (nothing recorded)\n`
    const lines = list.map(it => `- [${it.id}] ${it.title}`)
    return `## ${title}\n${lines.join('\n')}\n`
  }

  return [
    `# Daily Summary — ${date}`,
    '',
    renderSection('Done', done),
    renderSection('Decisions', decisions),
    renderSection('Open Loops', openLoops),
    renderSection('Next', next),
  ].join('\n')
}

// ── subcommands ───────────────────────────────────────────────────────────────

async function cmdSummarize(args: ParsedArgs): Promise<string> {
  const fromStdin = flagBool(args.flags, 'from-stdin')
  const paths = relayMindPaths(process.cwd())
  await mkdir(paths.dailyDir, { recursive: true })

  if (fromStdin) {
    // Claude writes its own summary — read from stdin and store it.
    const markdown = (await readStdin()).trim()
    if (!markdown) throw new Error('--from-stdin: no content received on stdin')

    // Try to extract date from the first heading: "# Daily Summary — YYYY-MM-DD"
    const m = /^# Daily Summary — (\d{4}-\d{2}-\d{2})/m.exec(markdown)
    const date = m ? m[1] : todayUtc()

    const filePath = join(paths.dailyDir, `${date}.md`)
    await atomicWrite(filePath, markdown + '\n')

    const db = openMemoryDb(paths.memoryDb)
    try {
      const repo = new MemoryRepo(db)
      repo.addItem({
        type: 'daily_summary',
        title: `Daily Summary — ${date}`,
        body: markdown,
        source: filePath,
        day: date,
        importance: 1,
      })
    } finally {
      db.close()
    }

    return `stored daily summary for ${date} (${filePath})`
  }

  // Deterministic aggregation path.
  const date = flagStr(args.flags, 'date') ?? todayUtc()
  if (!isValidDate(date)) throw new Error(`--date must be YYYY-MM-DD, got: ${date}`)

  const db = openMemoryDb(paths.memoryDb)
  let markdown: string
  let filePath: string
  try {
    const repo = new MemoryRepo(db)
    // Fetch all items for this date, excluding daily_summary items.
    const stmt = db.prepare<{
      id: number
      type: string
      title: string
      body: string
      source: string | null
      day: string
      importance: number
      created_at: string
      updated_at: string
    }>(`SELECT * FROM items WHERE day = ? AND type != 'daily_summary' ORDER BY id ASC`)
    const rows = stmt.all(date)
    const items: MemoryItem[] = rows.map(r => ({
      id: r.id,
      type: r.type as MemoryItem['type'],
      title: r.title,
      body: r.body,
      source: r.source,
      day: r.day,
      importance: r.importance,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))

    markdown = buildSummaryMarkdown(date, items)
    filePath = join(paths.dailyDir, `${date}.md`)
    await atomicWrite(filePath, markdown + '\n')

    // FTS-index the summary.
    repo.addItem({
      type: 'daily_summary',
      title: `Daily Summary — ${date}`,
      body: markdown,
      source: filePath,
      day: date,
      importance: 1,
    })
  } finally {
    db.close()
  }

  return `daily summary written to ${filePath}`
}

async function cmdShow(args: ParsedArgs): Promise<string> {
  const date = args.positional[0] ?? todayUtc()
  if (!isValidDate(date)) throw new Error(`date must be YYYY-MM-DD, got: ${date}`)

  const paths = relayMindPaths(process.cwd())
  const filePath = join(paths.dailyDir, `${date}.md`)

  try {
    await stat(filePath)
  } catch {
    return `no daily summary for ${date} (${filePath} not found)`
  }

  return await readFile(filePath, 'utf8')
}

async function cmdSearch(args: ParsedArgs): Promise<string> {
  const query = args.positional.join(' ').trim()
  if (!query) throw new Error('daily search requires a query')

  const json = flagBool(args.flags, 'json')
  const limit = (() => {
    const v = flagStr(args.flags, 'limit')
    if (v === undefined) return 20
    const n = Number.parseInt(v, 10)
    if (!Number.isFinite(n)) throw new Error('--limit must be an integer')
    return n
  })()

  const paths = relayMindPaths(process.cwd())
  const db = openMemoryDb(paths.memoryDb)
  try {
    const repo = new MemoryRepo(db)
    const hits = repo.search({ query, limit, types: ['daily_summary'] })
    if (json) return JSON.stringify(hits)
    if (hits.length === 0) return 'no daily summary matches'
    return hits.map(h => `${h.score.toFixed(3)}  [${h.item.id}] ${h.item.day}  ${h.item.title}`).join('\n')
  } finally {
    db.close()
  }
}

// ── entry ─────────────────────────────────────────────────────────────────────

const HELP = `viberelay relaymind daily <subcommand>

  summarize [--date YYYY-MM-DD]   Aggregate items for the date into a markdown
                                   summary, write the file, index in SQLite FTS.
                                   Defaults to today (UTC).
  summarize --from-stdin           Read pre-built summary from stdin (Claude path).
  show [YYYY-MM-DD]                Print the summary file for the given date.
  search "<query>" [--limit N]     FTS search over daily_summary items.`

const HANDLERS: Record<string, (args: ParsedArgs) => Promise<string>> = {
  summarize: cmdSummarize,
  show: cmdShow,
  search: cmdSearch,
}

export default async function dailyCommand(argv: string[], _baseUrl: string): Promise<string> {
  void _baseUrl
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return HELP
  const handler = HANDLERS[sub]
  if (!handler) throw new Error(`unknown daily subcommand: ${sub}\n\n${HELP}`)
  return handler(parseArgs(argv.slice(1)))
}
