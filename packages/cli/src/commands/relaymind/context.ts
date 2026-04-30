/**
 * `viberelay relaymind context render` — context injection for Claude Code hooks.
 *
 * Subcommand:
 *   render --event <session-start|user-prompt|pre-compact|stop>
 *          [--prompt "..."]
 *          [--from-stdin]        — read hook JSON payload from stdin (D3 fields)
 *          [--internal-json]     — emit our internal ContextRenderOutput shape
 *                                   instead of the Claude-Code hook-output shape
 *
 * ── Hook output contract (why we emit hookSpecificOutput) ────────────────────
 * Claude Code's SessionStart and UserPromptSubmit hooks ONLY inject context
 * into the model's prompt when the hook's stdout is the documented JSON shape:
 *
 *   {"hookSpecificOutput":{"hookEventName":"<PascalCase>","additionalContext":"<md>"},
 *    "continue": true}
 *
 * Anything else (including our internal {text, contextEstimate, recommendation}
 * shape) is silently discarded by Claude Code, so SOUL/TOOLS/MEMORY never reach
 * the model. By default this command emits the Claude-Code-compatible shape,
 * which mirrors how `claude-mem` injects its own context. Programmatic callers
 * (skill scripts, watchdog, supervisor) that want the rich shape pass
 * `--internal-json` to opt back into ContextRenderOutput. PreCompact and Stop
 * never inject context — they just persist the checkpoint-needed flag and exit
 * with `{"continue": true}`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import {
  MemoryRepo,
  openMemoryDb,
  relayMindPaths,
  type ContextEvent,
  type ContextPressure,
  type ContextRenderOutput,
} from '@viberelay/shared/relaymind'

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

/** Try to read a file; return empty string if missing. */
async function tryRead(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** Get file size in bytes; returns 0 when file is missing. */
async function fileSize(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath)
    return s.size
  } catch {
    return 0
  }
}

/** Classify context pressure from transcript size. */
function classifyPressure(bytes: number): ContextPressure {
  if (bytes < 100 * 1024) return 'low'         // < 100 KB
  if (bytes < 1024 * 1024) return 'medium'     // < 1 MB
  if (bytes < 5 * 1024 * 1024) return 'high'   // < 5 MB
  return 'critical'
}

/** Hook payload fields per DECISIONS D3. */
interface HookPayload {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  prompt?: string
}

// ── event normalization ───────────────────────────────────────────────────────

const EVENT_PASCAL_TO_KEBAB: Record<string, ContextEvent> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt',
  PreCompact: 'pre-compact',
  Stop: 'stop',
}

const EVENT_KEBAB_TO_PASCAL: Record<ContextEvent, string> = {
  'session-start': 'SessionStart',
  'user-prompt': 'UserPromptSubmit',
  'pre-compact': 'PreCompact',
  'stop': 'Stop',
}

const VALID_KEBAB_EVENTS: readonly ContextEvent[] = [
  'session-start',
  'user-prompt',
  'pre-compact',
  'stop',
]

/** Accept both Claude-Code PascalCase ("SessionStart") and kebab-case ("session-start"). */
function normalizeEvent(raw: string): ContextEvent | null {
  if (raw in EVENT_PASCAL_TO_KEBAB) return EVENT_PASCAL_TO_KEBAB[raw]
  if ((VALID_KEBAB_EVENTS as readonly string[]).includes(raw)) return raw as ContextEvent
  return null
}

// ── core render ───────────────────────────────────────────────────────────────

async function renderContext(opts: {
  event: ContextEvent
  prompt?: string
  transcriptPath?: string
}): Promise<ContextRenderOutput> {
  const paths = relayMindPaths(process.cwd())

  // Always inject the three identity/guide files.
  const [soulMd, toolsMd, memoryMd] = await Promise.all([
    tryRead(paths.soulMd),
    tryRead(paths.toolsMd),
    tryRead(paths.memoryMd),
  ])

  const sections: string[] = []

  if (soulMd.trim()) {
    sections.push(`<!-- SOUL.md -->\n${soulMd.trim()}`)
  }
  if (toolsMd.trim()) {
    sections.push(`<!-- TOOLS.md -->\n${toolsMd.trim()}`)
  }
  if (memoryMd.trim()) {
    sections.push(`<!-- MEMORY.md -->\n${memoryMd.trim()}`)
  }

  // Memory search for user-prompt events.
  const hitIds: number[] = []
  if (opts.event === 'user-prompt' && opts.prompt?.trim()) {
    const db = openMemoryDb(paths.memoryDb)
    try {
      const repo = new MemoryRepo(db)
      const hits = repo.search({ query: opts.prompt, limit: 5 })
      if (hits.length > 0) {
        const lines = hits.map(
          h => `- [${h.item.id}] ${h.item.type} (${h.item.day}) ${h.item.title} — score ${h.score.toFixed(3)}`,
        )
        sections.push(`## Relevant memory\n${lines.join('\n')}`)
        hitIds.push(...hits.map(h => h.item.id))
      }
    } finally {
      db.close()
    }
  }

  // Compute context pressure from transcript size and checkpoint age.
  const transcriptBytes = opts.transcriptPath ? await fileSize(opts.transcriptPath) : 0
  let pressure = classifyPressure(transcriptBytes)

  // Check checkpoint age — if last checkpoint older than 6h, bump pressure.
  const db = openMemoryDb(paths.memoryDb)
  let checkpointAge = Infinity
  try {
    const repo = new MemoryRepo(db)
    // Get the most recent checkpoint by querying directly (repo has no latestCheckpoint method).
    const row = db
      .prepare<{ created_at: string }>(
        `SELECT created_at FROM items WHERE type = 'checkpoint' ORDER BY id DESC LIMIT 1`,
      )
      .get()
    if (row) {
      checkpointAge = (Date.now() - Date.parse(row.created_at)) / (1000 * 60 * 60)
    }
    void repo // used to open db in right mode
  } finally {
    db.close()
  }

  if (checkpointAge > 6) {
    // Bump one tier if not already critical.
    if (pressure === 'low') pressure = 'medium'
    else if (pressure === 'medium') pressure = 'high'
    else if (pressure === 'high') pressure = 'critical'
  }

  // Derive recommendation.
  let recommendation: ContextRenderOutput['recommendation']
  const isCompactOrStop = opts.event === 'pre-compact' || opts.event === 'stop'
  if (isCompactOrStop || pressure === 'critical') {
    recommendation = 'checkpoint-now'
  } else if (pressure === 'high') {
    recommendation = 'checkpoint-soon'
  } else if (pressure === 'medium') {
    recommendation = 'continue'
  } else {
    recommendation = 'continue'
  }

  // Append context estimate banner.
  sections.push(
    `## Context estimate\npressure: ${pressure}\nrecommendation: ${recommendation}`,
  )

  // For pre-compact and stop: write the checkpoint-needed flag.
  if (isCompactOrStop) {
    const flagPath = join(paths.supervisorStateDir, 'checkpoint-needed')
    await mkdir(paths.supervisorStateDir, { recursive: true })
    await writeFile(flagPath, `${opts.event}\n`, 'utf8')
  }

  return {
    text: sections.join('\n\n'),
    contextEstimate: pressure,
    recommendation,
    hitIds: hitIds.length > 0 ? hitIds : undefined,
  }
}

// ── Claude Code hook output shape ────────────────────────────────────────────

interface ClaudeHookOutput {
  continue: boolean
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext: string
  }
}

/**
 * Build the Claude-Code-compatible hook output. Only SessionStart and
 * UserPromptSubmit get `additionalContext`; PreCompact / Stop just continue.
 */
function buildHookOutput(event: ContextEvent, rendered: ContextRenderOutput): ClaudeHookOutput {
  const pascal = EVENT_KEBAB_TO_PASCAL[event]
  if (event === 'pre-compact' || event === 'stop') {
    return { continue: true }
  }
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: pascal,
      additionalContext: rendered.text,
    },
  }
}

// ── subcommands ───────────────────────────────────────────────────────────────

async function cmdRender(args: ParsedArgs): Promise<string> {
  const fromStdin = flagBool(args.flags, 'from-stdin')
  const internalJson = flagBool(args.flags, 'internal-json')

  let event: ContextEvent
  let prompt: string | undefined
  let transcriptPath: string | undefined

  if (fromStdin) {
    const raw = await readStdin()
    let payload: HookPayload = {}
    try {
      payload = JSON.parse(raw) as HookPayload
    } catch {
      // Malformed stdin → emit a benign continue:true so Claude Code doesn't
      // log the hook as failed. Internal-json callers still get a usable shape.
      if (internalJson) {
        return JSON.stringify({
          text: '',
          contextEstimate: 'low' as ContextPressure,
          recommendation: 'continue' as ContextRenderOutput['recommendation'],
        } satisfies ContextRenderOutput)
      }
      return JSON.stringify({ continue: true } satisfies ClaudeHookOutput)
    }
    const hookEventRaw = payload.hook_event_name ?? flagStr(args.flags, 'event')
    if (!hookEventRaw) {
      throw new Error('--event is required (or pass hook payload via --from-stdin)')
    }
    const normalized = normalizeEvent(hookEventRaw)
    if (!normalized) {
      throw new Error(`--event must be one of: ${VALID_KEBAB_EVENTS.join(', ')}`)
    }
    event = normalized
    prompt = payload.prompt ?? flagStr(args.flags, 'prompt')
    transcriptPath = payload.transcript_path
  } else {
    const eventFlag = flagStr(args.flags, 'event')
    if (!eventFlag) throw new Error('--event is required')
    const normalized = normalizeEvent(eventFlag)
    if (!normalized) {
      throw new Error(`--event must be one of: ${VALID_KEBAB_EVENTS.join(', ')}`)
    }
    event = normalized
    prompt = flagStr(args.flags, 'prompt')
    transcriptPath = flagStr(args.flags, 'transcript-path')
  }

  const output = await renderContext({ event, prompt, transcriptPath })

  if (internalJson) {
    return JSON.stringify(output)
  }
  return JSON.stringify(buildHookOutput(event, output))
}

// ── entry ─────────────────────────────────────────────────────────────────────

const HELP = `viberelay relaymind context render

  render --event <session-start|user-prompt|pre-compact|stop>
         [--prompt "..."]
         [--from-stdin]      Read JSON hook payload from stdin (D3 fields).
         [--internal-json]   Emit ContextRenderOutput instead of the
                             Claude-Code hook-output shape.

  Default stdout: Claude Code hookSpecificOutput JSON.`

export default async function contextCommand(argv: string[], _baseUrl: string): Promise<string> {
  void _baseUrl
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return HELP
  if (sub !== 'render') throw new Error(`unknown context subcommand: ${sub}\n\n${HELP}`)
  return cmdRender(parseArgs(argv.slice(1)))
}
