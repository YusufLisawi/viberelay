/**
 * `viberelay relaymind checkpoint <subcommand>` — checkpoint management.
 *
 * Subcommands:
 *   write --title "..." --body "..." [--from-stdin]
 *     Stores a checkpoint item in SQLite and clears the checkpoint-needed flag.
 *   maybe
 *     Exits 0 with "checkpoint-needed" when the flag file exists, else
 *     "no checkpoint needed".
 *   latest
 *     Fetches the most recent checkpoint item and prints title + body.
 *
 * No LLM calls. All logic is deterministic.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { MemoryRepo, openMemoryDb, relayMindPaths } from '@viberelay/shared/relaymind'

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

/** Read all text from stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Returns true when the checkpoint-needed flag file exists. */
async function checkpointFlagExists(flagPath: string): Promise<boolean> {
  try {
    await stat(flagPath)
    return true
  } catch {
    return false
  }
}

// ── subcommands ───────────────────────────────────────────────────────────────

async function cmdWrite(args: ParsedArgs): Promise<string> {
  const title = flagStr(args.flags, 'title')
  if (!title?.trim()) throw new Error('--title is required')

  const fromStdin = flagBool(args.flags, 'from-stdin')
  let body: string
  if (fromStdin) {
    body = (await readStdin()).trim()
    if (!body) throw new Error('--from-stdin: no content received on stdin')
  } else {
    const b = flagStr(args.flags, 'body')
    if (!b?.trim()) throw new Error('--body is required (or use --from-stdin)')
    body = b
  }

  const paths = relayMindPaths(process.cwd())

  // Store in SQLite.
  const db = openMemoryDb(paths.memoryDb)
  let itemId: number
  try {
    const repo = new MemoryRepo(db)
    const item = repo.addItem({
      type: 'checkpoint',
      title: title.trim(),
      body,
      importance: 2,
    })
    itemId = item.id
  } finally {
    db.close()
  }

  // Clear the checkpoint-needed flag if present.
  const flagPath = join(paths.supervisorStateDir, 'checkpoint-needed')
  try {
    await rm(flagPath, { force: true })
  } catch {
    // Ignore if it doesn't exist.
  }

  return `checkpoint [${itemId}] written: ${title.trim()}`
}

async function cmdMaybe(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const flagPath = join(paths.supervisorStateDir, 'checkpoint-needed')
  const needed = await checkpointFlagExists(flagPath)
  return needed ? 'checkpoint-needed' : 'no checkpoint needed'
}

async function cmdLatest(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const db = openMemoryDb(paths.memoryDb)
  try {
    const row = db
      .prepare<{ id: number; title: string; body: string; created_at: string }>(
        `SELECT id, title, body, created_at FROM items WHERE type = 'checkpoint' ORDER BY id DESC LIMIT 1`,
      )
      .get()
    if (!row) return 'no checkpoints found'
    return `[${row.id}] ${row.title}\n${row.created_at}\n\n${row.body}`
  } finally {
    db.close()
  }
}

// ── entry ─────────────────────────────────────────────────────────────────────

const HELP = `viberelay relaymind checkpoint <subcommand>

  write --title "..." --body "..."   Store a checkpoint item and clear the flag.
        [--from-stdin]               Read body from stdin instead.
  maybe                              Print "checkpoint-needed" or "no checkpoint needed".
  latest                             Print the most recent checkpoint title + body.`

const HANDLERS: Record<string, (args: ParsedArgs) => Promise<string>> = {
  write: cmdWrite,
  maybe: cmdMaybe,
  latest: cmdLatest,
}

export default async function checkpointCommand(argv: string[], _baseUrl: string): Promise<string> {
  void _baseUrl
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return HELP
  const handler = HANDLERS[sub]
  if (!handler) throw new Error(`unknown checkpoint subcommand: ${sub}\n\n${HELP}`)
  return handler(parseArgs(argv.slice(1)))
}
