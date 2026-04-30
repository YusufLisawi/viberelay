/**
 * `viberelay relaymind telegram <subcommand>` — RelayMind-namespaced Telegram
 * command registry management.
 *
 * Subcommands:
 *   commands list      — list all commands (name/mode/risk/enabled).
 *   commands validate  — validate registry.json schema and handler file presence.
 *   commands reload    — write a manifest-reload signal file (D4 stub).
 *
 * Note: this is distinct from the top-level `viberelay telegram` command; this
 * namespace is owned by RelayMind and scoped to the relaymind profile.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { relayMindPaths } from '@viberelay/shared/relaymind'
import type { TelegramCommandManifestEntry, TelegramCommandManifest } from '@viberelay/shared/relaymind'

// ── pairing / access (deterministic, no LLM) ──────────────────────────────────

interface AccessFile {
  dmPolicy?: 'pairing' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>
  pending?: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number }>
  mentionPatterns?: string[]
}

function defaultAccess(): AccessFile {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

async function readAccess(stateDir: string): Promise<AccessFile> {
  const p = join(stateDir, 'access.json')
  if (!(await fileExists(p))) return defaultAccess()
  try {
    const raw = await readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AccessFile>
    return { ...defaultAccess(), ...parsed }
  } catch (err) {
    throw new Error(`access.json at ${p} is malformed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function writeAccess(stateDir: string, value: AccessFile): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const target = join(stateDir, 'access.json')
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

async function writeApprovalSignal(stateDir: string, senderId: string, chatId: string): Promise<void> {
  const dir = join(stateDir, 'approved')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, senderId)
  const tmp = `${target}.tmp`
  await writeFile(tmp, chatId, 'utf8')
  await rename(tmp, target)
}

function resolveStateDir(): string {
  // Honor TELEGRAM_STATE_DIR if set (e.g. when the user runs the command
  // from inside the relaymind tmux session). Otherwise default to the
  // profile-local path so `relaymind telegram pair <code>` from any shell
  // mutates THIS profile's state, not `~/.claude/channels/telegram/`.
  if (process.env.TELEGRAM_STATE_DIR) return process.env.TELEGRAM_STATE_DIR
  return relayMindPaths(process.cwd()).telegramStateDir
}

async function cmdPairStatus(): Promise<string> {
  const stateDir = resolveStateDir()
  const a = await readAccess(stateDir)
  const allow = a.allowFrom ?? []
  const pending = a.pending ?? {}
  const groups = a.groups ?? {}
  const lines: string[] = []
  lines.push(`state dir: ${stateDir}`)
  lines.push(`policy:    ${a.dmPolicy ?? 'pairing'}`)
  lines.push(`allowFrom: ${allow.length === 0 ? '(none)' : allow.join(', ')}`)
  if (Object.keys(pending).length > 0) {
    lines.push('pending:')
    for (const [code, p] of Object.entries(pending)) {
      const ageSec = Math.max(0, Math.floor((Date.now() - p.createdAt) / 1000))
      const expSec = Math.max(0, Math.floor((p.expiresAt - Date.now()) / 1000))
      lines.push(`  ${code} sender=${p.senderId} chat=${p.chatId} age=${ageSec}s expiresIn=${expSec}s`)
    }
  } else {
    lines.push('pending:   (none)')
  }
  lines.push(`groups:    ${Object.keys(groups).length}`)
  return lines.join('\n')
}

async function cmdPair(args: ParsedArgs): Promise<string> {
  const code = args.positional[0]
  if (!code) throw new Error('Usage: relaymind telegram pair <code>')
  const stateDir = resolveStateDir()
  const a = await readAccess(stateDir)
  const pending = a.pending ?? {}
  const entry = pending[code]
  if (!entry) throw new Error(`no pending pairing with code '${code}'`)
  if (entry.expiresAt < Date.now()) throw new Error(`pairing code '${code}' has expired`)
  const allow = new Set(a.allowFrom ?? [])
  allow.add(entry.senderId)
  delete pending[code]
  await writeAccess(stateDir, { ...a, allowFrom: [...allow], pending })
  await writeApprovalSignal(stateDir, entry.senderId, entry.chatId)
  return `paired senderId=${entry.senderId} chatId=${entry.chatId} (state: ${stateDir})`
}

async function cmdDeny(args: ParsedArgs): Promise<string> {
  const code = args.positional[0]
  if (!code) throw new Error('Usage: relaymind telegram deny <code>')
  const stateDir = resolveStateDir()
  const a = await readAccess(stateDir)
  const pending = a.pending ?? {}
  if (!pending[code]) throw new Error(`no pending pairing with code '${code}'`)
  delete pending[code]
  await writeAccess(stateDir, { ...a, pending })
  return `denied pairing code '${code}'`
}

async function cmdAllow(args: ParsedArgs): Promise<string> {
  const senderId = args.positional[0]
  if (!senderId) throw new Error('Usage: relaymind telegram allow <senderId>')
  const stateDir = resolveStateDir()
  const a = await readAccess(stateDir)
  const allow = new Set(a.allowFrom ?? [])
  if (allow.has(senderId)) return `already allowed: ${senderId}`
  allow.add(senderId)
  await writeAccess(stateDir, { ...a, allowFrom: [...allow] })
  return `allowed senderId=${senderId}`
}

async function cmdRemove(args: ParsedArgs): Promise<string> {
  const senderId = args.positional[0]
  if (!senderId) throw new Error('Usage: relaymind telegram remove <senderId>')
  const stateDir = resolveStateDir()
  const a = await readAccess(stateDir)
  const before = a.allowFrom ?? []
  const after = before.filter((s) => s !== senderId)
  if (after.length === before.length) return `not in allowlist: ${senderId}`
  await writeAccess(stateDir, { ...a, allowFrom: after })
  return `removed senderId=${senderId}`
}

async function cmdPolicy(args: ParsedArgs): Promise<string> {
  const mode = args.positional[0]
  if (!mode || !['pairing', 'allowlist', 'disabled'].includes(mode)) {
    throw new Error('Usage: relaymind telegram policy <pairing|allowlist|disabled>')
  }
  const stateDir = resolveStateDir()
  const a = await readAccess(stateDir)
  await writeAccess(stateDir, { ...a, dmPolicy: mode as AccessFile['dmPolicy'] })
  return `dmPolicy=${mode}`
}

async function cmdSetToken(args: ParsedArgs): Promise<string> {
  const token = args.positional[0]
  if (!token) throw new Error('Usage: relaymind telegram set-token <token>')
  const stateDir = resolveStateDir()
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const target = join(stateDir, '.env')
  // Preserve other keys if .env already exists.
  let body = `TELEGRAM_BOT_TOKEN=${token}\n`
  if (await fileExists(target)) {
    const existing = await readFile(target, 'utf8')
    const lines = existing.split(/\r?\n/).filter((l) => l && !l.startsWith('TELEGRAM_BOT_TOKEN='))
    body = [`TELEGRAM_BOT_TOKEN=${token}`, ...lines].join('\n') + '\n'
  }
  const tmp = `${target}.tmp`
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, target)
  return `wrote TELEGRAM_BOT_TOKEN to ${target} (mode 0600)`
}

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

/** Read and parse registry.json; throws on invalid JSON. */
async function loadRegistry(registryPath: string): Promise<TelegramCommandManifest> {
  let raw: string
  try {
    raw = await readFile(registryPath, 'utf8')
  } catch {
    throw new Error(`registry.json not found at ${registryPath}`)
  }
  const parsed = JSON.parse(raw) as Partial<TelegramCommandManifest>
  if (!Array.isArray(parsed.commands)) {
    throw new Error('registry.json must have a top-level "commands" array')
  }
  return parsed as TelegramCommandManifest
}

// ── validation ────────────────────────────────────────────────────────────────

interface ValidationError {
  index: number
  name: string
  error: string
}

async function validateRegistry(
  manifest: TelegramCommandManifest,
  handlersDir: string,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = []
  const validModes = new Set(['direct', 'llm'])
  const validRisks = new Set(['read', 'write', 'external', 'destructive', undefined])

  for (let i = 0; i < manifest.commands.length; i++) {
    const cmd = manifest.commands[i]
    const name = typeof cmd.name === 'string' ? cmd.name : `<entry ${i}>`

    if (typeof cmd.name !== 'string' || !cmd.name.trim()) {
      errors.push({ index: i, name, error: 'missing or empty "name"' })
    }
    if (typeof cmd.description !== 'string' || !cmd.description.trim()) {
      errors.push({ index: i, name, error: 'missing or empty "description"' })
    }
    if (!validModes.has(cmd.mode)) {
      errors.push({ index: i, name, error: `invalid mode "${String(cmd.mode)}" — must be "direct" or "llm"` })
    }
    if (!validRisks.has(cmd.risk)) {
      errors.push({
        index: i,
        name,
        error: `invalid risk "${String(cmd.risk)}" — must be "read", "write", "external", or "destructive"`,
      })
    }
    if (cmd.mode === 'direct') {
      if (typeof cmd.handler !== 'string' || !cmd.handler.trim()) {
        errors.push({ index: i, name, error: 'direct command missing "handler"' })
      } else {
        // Check handler file exists (try .ts extension).
        const handlerPath = join(handlersDir, `${cmd.handler}.ts`)
        try {
          await stat(handlerPath)
        } catch {
          errors.push({ index: i, name, error: `handler file not found: ${handlerPath}` })
        }
      }
    }
    if (cmd.mode === 'llm') {
      if (typeof cmd.template !== 'string' || !cmd.template.trim()) {
        errors.push({ index: i, name, error: 'llm command missing "template"' })
      }
    }
  }

  return errors
}

// ── subcommands ───────────────────────────────────────────────────────────────

async function cmdCommandsList(args: ParsedArgs): Promise<string> {
  const json = args.flags['json'] === true
  const paths = relayMindPaths(process.cwd())
  const manifest = await loadRegistry(paths.registryJson)

  if (json) return JSON.stringify(manifest.commands)

  if (manifest.commands.length === 0) return 'no commands registered'

  const lines = manifest.commands.map((cmd: TelegramCommandManifestEntry) => {
    const enabled = (cmd.enabled ?? true) ? 'enabled' : 'disabled'
    const risk = cmd.risk ?? '-'
    return `/${cmd.name.padEnd(20)} [${cmd.mode.padEnd(6)}] risk=${risk.padEnd(11)} ${enabled}  ${cmd.description}`
  })
  return lines.join('\n')
}

async function cmdCommandsValidate(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  let manifest: TelegramCommandManifest
  try {
    manifest = await loadRegistry(paths.registryJson)
  } catch (err) {
    return `FAIL: ${err instanceof Error ? err.message : String(err)}`
  }

  const errors = await validateRegistry(manifest, paths.handlersDir)
  if (errors.length === 0) {
    return `OK: registry.json is valid (${manifest.commands.length} commands)`
  }
  const lines = errors.map(e => `  [${e.index}] ${e.name}: ${e.error}`)
  return `FAIL: ${errors.length} error(s) in registry.json\n${lines.join('\n')}`
}

async function cmdCommandsReload(_args: ParsedArgs): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const reloadFlag = join(paths.supervisorStateDir, 'registry-reload-requested')
  await writeFile(reloadFlag, new Date().toISOString() + '\n', 'utf8')
  return `reload signal written to ${reloadFlag} (manifest-only reload — plugin will pick this up on next invocation)`
}

// ── commands dispatcher ───────────────────────────────────────────────────────

const COMMANDS_HANDLERS: Record<string, (args: ParsedArgs) => Promise<string>> = {
  list: cmdCommandsList,
  validate: cmdCommandsValidate,
  reload: cmdCommandsReload,
}

function handleCommandsSubcommand(sub: string, args: ParsedArgs): Promise<string> {
  const handler = COMMANDS_HANDLERS[sub]
  if (!handler) {
    throw new Error(`unknown commands subcommand: ${sub} — valid: list, validate, reload`)
  }
  return handler(args)
}

// ── entry ─────────────────────────────────────────────────────────────────────

const HELP = `viberelay relaymind telegram <subcommand>

Pairing & access (writes to <profile>/.relaymind/telegram/access.json,
honoring $TELEGRAM_STATE_DIR when set — never touches ~/.claude/):

  pair                        Show current pairing status (policy, allowlist, pending).
  pair <code>                 Approve a pending pairing code from your bot.
  deny <code>                 Drop a pending code without approving.
  allow <senderId>            Add a Telegram user id to the allowlist.
  remove <senderId>           Remove a Telegram user id from the allowlist.
  policy <pairing|allowlist|disabled>
                              Set DM policy.
  set-token <token>           Write TELEGRAM_BOT_TOKEN to the profile-local .env (mode 0600).

Slash-command registry:

  commands list               List all registered commands (name/mode/risk/enabled).
  commands validate           Validate registry.json schema and handler file presence.
  commands reload             Write a manifest-reload signal (D4 stub).`

export default async function telegramCommand(argv: string[], _baseUrl: string): Promise<string> {
  void _baseUrl
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return HELP

  if (sub === 'commands') {
    const commandsSub = argv[1]
    if (!commandsSub) return HELP
    return handleCommandsSubcommand(commandsSub, parseArgs(argv.slice(2)))
  }

  const rest = argv.slice(1)
  switch (sub) {
    case 'pair': {
      // `pair` with no args = status; `pair <code>` = approve.
      if (rest.length === 0) return cmdPairStatus()
      return cmdPair(parseArgs(rest))
    }
    case 'deny':       return cmdDeny(parseArgs(rest))
    case 'allow':      return cmdAllow(parseArgs(rest))
    case 'remove':     return cmdRemove(parseArgs(rest))
    case 'policy':     return cmdPolicy(parseArgs(rest))
    case 'set-token':  return cmdSetToken(parseArgs(rest))
    case 'status':     return cmdPairStatus()
  }

  throw new Error(`unknown telegram subcommand: ${sub}\n\n${HELP}`)
}
