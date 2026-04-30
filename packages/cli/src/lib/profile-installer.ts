/**
 * RelayMind isolated-profile installer.
 *
 * Pure functions over `RelayMindPaths`. Every operation is idempotent:
 * directories are created with `recursive: true`, context files are only
 * written when missing (or `force` is set), and the existing command
 * registry is preserved on re-runs.
 *
 * Per docs/relaymind/DECISIONS.md §D2 the "isolated profile" is a
 * directory, not a Claude Code primitive — this module just lays it down.
 *
 * Plugin payloads (skills, hooks, context fragments, settings fragment)
 * live under `relaymind-plugin-cc/` at the repo root. The installer copies
 * that bundle into the profile's `.claude/plugins/relaymind/` so Claude
 * Code loads them as a project-local plugin. The Telegram plugin under
 * `telegram-plugin-cc/` is similarly copied into
 * `.claude/plugins/vibemind-telegram/` per PRD §149.
 */

import { mkdir, readFile, readdir, writeFile, access, chmod, stat, rename, rm, copyFile, realpath } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import type { RelayMindConfig, RelayMindPaths, ViberelayProfileBinding } from '@viberelay/shared/relaymind'
import { runProfileCommand } from '../commands/profile.js'

// ── Inline fallbacks ─────────────────────────────────────────────────────────
// Used only if the plugin bundle is missing on disk (e.g. someone shipped the
// CLI without `relaymind-plugin-cc/`). Kept terse — the plugin bundle is the
// real source-of-truth and these are last-resort copies.

const FALLBACK_SOUL_MD = `# RelayMind — Assistant Identity

You are RelayMind, a persistent Telegram-connected Claude Code assistant
running in an isolated profile under \`.relaymind/claude-home/\`.
`

const FALLBACK_TOOLS_MD = `# RelayMind — Tools and CLI Surface

All RelayMind operations go through the \`viberelay relaymind\` namespace.
See \`viberelay relaymind help\` for the full surface.
`

const FALLBACK_CLAUDE_MD = `# RelayMind Profile — CLAUDE.md

You are running inside the RelayMind isolated Claude Code profile. See
\`SOUL.md\`, \`TOOLS.md\`, and \`MEMORY.md\`.
`

const FALLBACK_MEMORY_MD = `# Active Goals

_(none yet)_

# Open Loops

_(none yet)_

# Recent Decisions

_(none yet)_

# User Preferences

_(none yet)_

# Current Assistant State

_(initialized — awaiting first session)_

# Last Checkpoint

_(none yet)_
`

const DEFAULT_REGISTRY = {
  commands: [
    {
      name: 'usage',
      description: 'Show viberelay usage',
      mode: 'direct' as const,
      handler: 'usage',
    },
    {
      name: 'fix',
      description: 'Investigate and fix an issue',
      mode: 'llm' as const,
      template:
        'You are handling the /fix command.\nInvestigate the issue below and make the smallest correct change.\n\nUser request:\n{{args}}',
    },
    {
      name: 'build',
      description: 'Plan or implement a feature',
      mode: 'llm' as const,
      template:
        'You are handling the /build command.\nDesign and implement the requested feature with minimal, correct changes.\n\nUser request:\n{{args}}',
    },
    {
      name: 'daily',
      description: 'Prepare a daily summary',
      mode: 'llm' as const,
      template:
        'You are handling the /daily command.\nSummarize the current work, decisions, and next steps.\n\nUser context:\n{{args}}',
    },
  ],
}

// ── Bundle resolution ────────────────────────────────────────────────────────

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * Markers used to locate a plugin bundle on disk.
 *
 * `short` is the basename used inside the production install layout
 * (`<execPathDir>/plugins/<short>/`), which is what `install-relaymind.sh`
 * extracts next to the binary.
 *
 * `long` is the basename used in the dev/source-tree checkout
 * (`<repo-root>/<long>/`), where the plugin lives under its development
 * directory name (e.g. `relaymind-plugin-cc/`).
 */
export interface BundleMarkers {
  short: string
  long: string
}

/**
 * Resolve the directory holding the running binary, after symlink resolution.
 *
 * `~/.local/bin/relaymind` is typically a symlink to
 * `~/.relaymind/dist/<version>/relaymind`. We want the latter — the install
 * tree is what holds `plugins/`. Falls back to non-real path if `realpath`
 * fails (e.g. the executable was unlinked between launch and lookup).
 */
async function resolveExecPathDir(): Promise<string | null> {
  const exec = process.execPath
  if (!exec) return null
  try {
    const real = await realpath(exec)
    return path.dirname(real)
  } catch {
    return path.dirname(exec)
  }
}

async function locateRepoBundle(markers: BundleMarkers, envOverride?: string): Promise<string | null> {
  // 1. Env-var override (explicit caller intent wins). Setting the env
  //    var is treated as authoritative — we never fall through to source
  //    discovery if the user told us where to look. A missing path under
  //    an explicit override returns null so callers see the misconfig
  //    rather than silently grabbing some other copy.
  if (envOverride) {
    const fromEnv = process.env[envOverride]
    if (typeof fromEnv === 'string' && fromEnv !== '') {
      return (await dirExists(fromEnv)) ? fromEnv : null
    }
  }

  // 2. Next to the running binary — production layout. Compiled binaries
  //    (bun --compile) cannot walk back to source via import.meta.url
  //    because the URL points into bun's virtual FS, so this is the
  //    primary resolution path for installed users.
  const execDir = await resolveExecPathDir()
  if (execDir) {
    const nextToBinary = path.join(execDir, 'plugins', markers.short)
    if (await dirExists(nextToBinary)) return nextToBinary
  }

  // 3. import.meta.url walk-up — dev mode (running via `bun bin.ts`).
  const here = path.dirname(fileURLToPath(import.meta.url))
  let cur = here
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(cur, markers.long)
    if (await dirExists(candidate)) return candidate
    const next = path.dirname(cur)
    if (next === cur) break
    cur = next
  }

  // 4. CWD fallback — useful when running from the repo root in dev.
  const cwdCandidate = path.join(process.cwd(), markers.long)
  if (await dirExists(cwdCandidate)) return cwdCandidate

  return null
}

const RELAYMIND_MARKERS: BundleMarkers = { short: 'relaymind', long: 'relaymind-plugin-cc' }
const TELEGRAM_MARKERS: BundleMarkers = { short: 'vibemind-telegram', long: 'telegram-plugin-cc' }

/** Resolve the relaymind plugin bundle root. */
export async function resolveRelayMindBundle(): Promise<string | null> {
  return locateRepoBundle(RELAYMIND_MARKERS, 'RELAYMIND_PLUGIN_ROOT')
}

/** Resolve the telegram plugin bundle root. */
export async function resolveTelegramBundle(): Promise<string | null> {
  return locateRepoBundle(TELEGRAM_MARKERS, 'VIBERELAY_TELEGRAM_PLUGIN_ROOT')
}

/** Internal hook for tests — resolve a bundle by markers without touching env. */
export async function _locateBundleForTest(markers: BundleMarkers): Promise<string | null> {
  return locateRepoBundle(markers)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function writeIfMissing(file: string, content: string, force: boolean): Promise<boolean> {
  if (!force && (await fileExists(file))) return false
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  return true
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

interface CopyOpts {
  /** Files/dirs to skip (basename match). */
  skip?: ReadonlySet<string>
  /** Make .sh files executable on copy. */
  chmodScripts?: boolean
}

async function copyTree(srcDir: string, destDir: string, opts: CopyOpts = {}): Promise<string[]> {
  const skip = opts.skip ?? new Set<string>()
  const written: string[] = []
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (skip.has(entry.name)) continue
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      const sub = await copyTree(src, dest, opts)
      written.push(...sub)
    } else if (entry.isFile()) {
      await copyFile(src, dest)
      written.push(dest)
      if (opts.chmodScripts && entry.name.endsWith('.sh')) {
        try {
          await chmod(dest, 0o755)
        } catch {
          // Non-POSIX filesystems: tolerated.
        }
      }
    }
  }
  return written
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function ensureProfileLayout(paths: RelayMindPaths): Promise<void> {
  const dirs = [
    paths.stateRoot,
    paths.claudeHome,
    paths.claudeProjectDir,
    paths.commandsDir,
    paths.handlersDir,
    paths.skillsDir,
    paths.hooksDir,
    paths.dailyDir,
    paths.supervisorStateDir,
  ]
  for (const d of dirs) {
    await mkdir(d, { recursive: true })
  }
}

// ── Context files (sourced from the plugin bundle) ───────────────────────────

export interface WriteContextOpts {
  force?: boolean
}

export interface WriteContextResult {
  written: Record<'soul' | 'tools' | 'claude' | 'memory', boolean>
}

const CLAUDE_BEGIN = '<!-- BEGIN RELAYMIND -->'
const CLAUDE_END = '<!-- END RELAYMIND -->'

async function readBundleFileOr(bundleRoot: string | null, rel: string, fallback: string): Promise<string> {
  if (!bundleRoot) return fallback
  try {
    return await readFile(path.join(bundleRoot, rel), 'utf8')
  } catch {
    return fallback
  }
}

/**
 * Merge RelayMind's CLAUDE.md fragment into `<profile>/CLAUDE.md`.
 *
 * Behavior:
 *  - File missing → write the fragment wrapped in BEGIN/END markers.
 *  - File present, contains markers → replace the marker block.
 *  - File present, no markers, force=false → preserve user file untouched
 *    (idempotency contract).
 *  - File present, no markers, force=true → append a marker block at the
 *    end so user content above is preserved.
 */
async function mergeClaudeMd(target: string, fragment: string, force: boolean): Promise<boolean> {
  const wrapped = `${CLAUDE_BEGIN}\n${fragment.trimEnd()}\n${CLAUDE_END}\n`
  const exists = await fileExists(target)
  if (!exists) {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, wrapped, 'utf8')
    return true
  }
  const current = await readFile(target, 'utf8')
  const beginIdx = current.indexOf(CLAUDE_BEGIN)
  const endIdx = current.indexOf(CLAUDE_END)
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = current.slice(0, beginIdx)
    const after = current.slice(endIdx + CLAUDE_END.length)
    const next = `${before}${wrapped.trimEnd()}${after.startsWith('\n') ? after : `\n${after}`}`
    if (next === current) return false
    await writeFile(target, next, 'utf8')
    return true
  }
  if (!force) return false
  // No markers, force: append our block while preserving user content.
  const sep = current.endsWith('\n') ? '' : '\n'
  await writeFile(target, `${current}${sep}\n${wrapped}`, 'utf8')
  return true
}

export async function writeContextFiles(
  paths: RelayMindPaths,
  opts: WriteContextOpts = {},
): Promise<WriteContextResult> {
  const force = opts.force === true
  await mkdir(paths.claudeHome, { recursive: true })

  const bundle = await resolveRelayMindBundle()
  const soul = await readBundleFileOr(bundle, 'context/SOUL.md', FALLBACK_SOUL_MD)
  const tools = await readBundleFileOr(bundle, 'context/TOOLS.md', FALLBACK_TOOLS_MD)
  const claudeFragment = await readBundleFileOr(bundle, 'context/CLAUDE.fragment.md', FALLBACK_CLAUDE_MD)
  const memory = await readBundleFileOr(bundle, 'context/MEMORY.md', FALLBACK_MEMORY_MD)

  return {
    written: {
      soul: await writeIfMissing(paths.soulMd, soul, force),
      tools: await writeIfMissing(paths.toolsMd, tools, force),
      claude: await mergeClaudeMd(paths.claudeMd, claudeFragment, force),
      memory: await writeIfMissing(paths.memoryMd, memory, force),
    },
  }
}

// ── Registry / config ────────────────────────────────────────────────────────

export async function writeDefaultRegistry(paths: RelayMindPaths): Promise<boolean> {
  if (await fileExists(paths.registryJson)) return false
  await mkdir(paths.commandsDir, { recursive: true })
  await writeFile(paths.registryJson, `${JSON.stringify(DEFAULT_REGISTRY, null, 2)}\n`, 'utf8')
  return true
}

export const DEFAULT_VIBERELAY_PROFILE: Required<ViberelayProfileBinding> = {
  name: 'relaymind',
  opus: 'high',
  sonnet: 'mid',
  haiku: 'low',
}

export interface WriteDefaultConfigOpts {
  /** Override the viberelay profile binding written to a fresh config. */
  viberelayProfile?: ViberelayProfileBinding
}

/** Drop undefined-valued keys so callers can spread `--flag` overrides without nulling defaults. */
function compact<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {}
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o) as Array<[keyof T, T[keyof T]]>) {
    if (v !== undefined) out[k] = v
  }
  return out
}

export async function writeDefaultConfig(
  paths: RelayMindPaths,
  opts: WriteDefaultConfigOpts = {},
): Promise<boolean> {
  if (await fileExists(paths.configJson)) return false
  const config: RelayMindConfig = {
    sessionName: 'relaymind-main',
    dailySummaryAt: '22:00',
    // 60s default — see RELAYMIND.md "Configuration". Existing user configs
    // are preserved (we only write when configJson is absent), so bumping
    // the default does not migrate live installations.
    healthCheckIntervalMs: 60_000,
    viberelayProfile: { ...DEFAULT_VIBERELAY_PROFILE, ...compact(opts.viberelayProfile) },
  }
  await mkdir(path.dirname(paths.configJson), { recursive: true })
  await writeFile(paths.configJson, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return true
}

// ── Viberelay profile creation ───────────────────────────────────────────────

export interface EnsureViberelayProfileOpts {
  baseUrl: string
  /** Override the profile binding (config-driven defaults applied otherwise). */
  binding?: ViberelayProfileBinding
  /**
   * Stdout sink for `runProfileCommand` (it writes interactive prompts to
   * stderr; tests can swallow stdout to keep test output clean).
   */
  stdout?: NodeJS.WritableStream
}

export interface EnsureViberelayProfileResult {
  ok: boolean
  profileName: string
  message: string
}

/**
 * Idempotent profile creation. Reads the resolved binding (caller-provided
 * or persisted in `config.json`), then calls `runProfileCommand({ argv:
 * ['create', ...] })` with `--no-interactive --force` so re-runs succeed.
 *
 * Failure is non-fatal — installer surfaces it as a WARN row but keeps
 * going (a missing viberelay profile flips the supervisor into the
 * bare-claude fallback path, not a hard error).
 */
export async function ensureViberelayProfile(
  paths: RelayMindPaths,
  opts: EnsureViberelayProfileOpts,
): Promise<EnsureViberelayProfileResult> {
  const persisted = await readPersistedBinding(paths)
  const binding: Required<ViberelayProfileBinding> = {
    ...DEFAULT_VIBERELAY_PROFILE,
    ...compact(persisted ?? undefined),
    ...compact(opts.binding),
  }
  try {
    const out = await runProfileCommand({
      baseUrl: opts.baseUrl,
      stdout: opts.stdout,
      argv: [
        'create',
        binding.name,
        '--opus', binding.opus,
        '--sonnet', binding.sonnet,
        '--haiku', binding.haiku,
        '--no-interactive',
        '--force',
        // Channels are NOT pinned on the profile. The supervisor injects
        // `--dangerously-load-development-channels plugin:<name>@vibemind-local`
        // for both plugins at start time (see supervisor.buildClaudeArgs).
        // Pinning them here would (a) duplicate the flag at every start
        // and (b) re-introduce the stale `plugin:telegram@telegram` reference
        // that broke v0.1.22 dogfooding.
      ],
    })
    // Persist the binding back to config.json on success so subsequent
    // start/setup runs see the same values.
    await persistBinding(paths, binding)
    const firstLine = out.split('\n')[0] ?? ''
    return { ok: true, profileName: binding.name, message: firstLine || `created viberelay profile ${binding.name}` }
  } catch (err) {
    return {
      ok: false,
      profileName: binding.name,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

async function readPersistedBinding(paths: RelayMindPaths): Promise<ViberelayProfileBinding | null> {
  if (!(await fileExists(paths.configJson))) return null
  try {
    const raw = await readFile(paths.configJson, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RelayMindConfig>
    return parsed.viberelayProfile ?? null
  } catch {
    return null
  }
}

async function persistBinding(paths: RelayMindPaths, binding: Required<ViberelayProfileBinding>): Promise<void> {
  let cfg: Partial<RelayMindConfig> = {}
  if (await fileExists(paths.configJson)) {
    try {
      cfg = JSON.parse(await readFile(paths.configJson, 'utf8')) as Partial<RelayMindConfig>
    } catch {
      cfg = {}
    }
  }
  const next: Partial<RelayMindConfig> = { ...cfg, viberelayProfile: binding }
  await atomicWriteJson(paths.configJson, next)
}

// ── Telegram pairing capture ─────────────────────────────────────────────────

export interface CaptureTelegramOpts {
  /** Env-var name that will hold the bot token (default `VIBERELAY_RELAYMIND_TOKEN`). */
  tokenEnv?: string
  /** Bot token literal — NOT written to disk; only used to print an export hint. */
  token?: string
  /** Telegram chat id to allowlist. */
  chatId?: string
}

export interface CaptureTelegramResult {
  /** True when something was actually persisted (token-env name or chat id). */
  changed: boolean
  /** Echo the env-var name so the caller can show the export hint. */
  tokenEnv: string
  /** True when the token literal was provided (caller should print export). */
  tokenProvided: boolean
  /** Final allowlist after de-dup. */
  allowedChats: string[]
  /**
   * Path to the profile-local `.env` file the token was persisted to. Set
   * only when `opts.token` was a non-empty literal. The plugin reads
   * `TELEGRAM_BOT_TOKEN` from this file via its `STATE_DIR/.env` loader.
   */
  tokenPersistedAt?: string
}

/**
 * Persist Telegram pairing hints into config.json. Secrets are NEVER written
 * to disk — only the env-var NAME goes in `telegramTokenEnv`. Caller is
 * responsible for printing the `export` hint to the user.
 */
export async function captureTelegramPairing(
  paths: RelayMindPaths,
  opts: CaptureTelegramOpts,
): Promise<CaptureTelegramResult> {
  const tokenEnv = opts.tokenEnv ?? 'VIBERELAY_RELAYMIND_TOKEN'

  let cfg: Partial<RelayMindConfig> = {}
  if (await fileExists(paths.configJson)) {
    try {
      cfg = JSON.parse(await readFile(paths.configJson, 'utf8')) as Partial<RelayMindConfig>
    } catch {
      cfg = {}
    }
  }

  let changed = false
  // Only update telegramTokenEnv when caller supplied a token (or an
  // explicit env-var name override). Avoids stamping the field on every
  // init re-run.
  if (opts.token !== undefined || opts.tokenEnv !== undefined) {
    if (cfg.telegramTokenEnv !== tokenEnv) {
      cfg.telegramTokenEnv = tokenEnv
      changed = true
    }
  }

  const existingChats = Array.isArray(cfg.allowedChats) ? cfg.allowedChats : []
  let nextChats = existingChats
  if (opts.chatId !== undefined && opts.chatId !== '') {
    if (!existingChats.includes(opts.chatId)) {
      nextChats = [...existingChats, opts.chatId]
      cfg.allowedChats = nextChats
      changed = true
    }
  }

  if (changed) {
    await atomicWriteJson(paths.configJson, cfg)
  }

  // When a literal token was supplied, persist it to the profile-LOCAL
  // telegram .env (`<telegramStateDir>/.env`) which the plugin reads.
  // The file is mode 0600 and lives inside `.relaymind/` — it never
  // touches `~/.claude/` or the user's global telegram state. Without this
  // step the user would need to re-export TELEGRAM_BOT_TOKEN in every
  // shell session.
  let tokenPersistedAt: string | undefined
  if (typeof opts.token === 'string' && opts.token !== '') {
    await mkdir(paths.telegramStateDir, { recursive: true, mode: 0o700 })
    const envContent = `TELEGRAM_BOT_TOKEN=${opts.token}\n`
    const tmp = `${paths.telegramEnvFile}.tmp`
    await writeFile(tmp, envContent, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, paths.telegramEnvFile)
    tokenPersistedAt = paths.telegramEnvFile
  }

  return {
    changed,
    tokenEnv,
    tokenProvided: typeof opts.token === 'string' && opts.token !== '',
    allowedChats: nextChats,
    tokenPersistedAt,
  }
}

// ── Plugin bundle copy ───────────────────────────────────────────────────────

export const RELAYMIND_PLUGIN_DIR = 'relaymind'
export const TELEGRAM_PLUGIN_DIR = 'vibemind-telegram'

/**
 * Marketplace name used by the profile-local `.claude-plugin/marketplace.json`
 * and the corresponding `--dangerously-load-development-channels` selectors
 * the supervisor passes to Claude Code. Single source of truth — bump in one
 * place if this ever needs to change.
 */
export const PROFILE_MARKETPLACE_NAME = 'vibemind-local'

/**
 * Plugin manifest names the marketplace declares. These MUST match the
 * `name` field in each plugin's `.claude-plugin/plugin.json`. Keeping the
 * constants here means the supervisor can build the channel selectors
 * (`plugin:<name>@vibemind-local`) without re-reading the manifests.
 */
export const RELAYMIND_PLUGIN_NAME = 'vibemind-relaymind'
export const TELEGRAM_PLUGIN_NAME = 'vibemind-telegram'

function pluginsRoot(paths: RelayMindPaths): string {
  return path.join(paths.claudeProjectDir, 'plugins')
}

export function relayMindPluginPath(paths: RelayMindPaths): string {
  return path.join(pluginsRoot(paths), RELAYMIND_PLUGIN_DIR)
}

export function telegramPluginPath(paths: RelayMindPaths): string {
  return path.join(pluginsRoot(paths), TELEGRAM_PLUGIN_DIR)
}

export interface InstallPluginBundleResult {
  installed: boolean
  bundleRoot: string | null
  filesWritten: number
}

/**
 * Copy the RelayMind plugin bundle (`relaymind-plugin-cc/`) into the
 * profile at `.claude/plugins/relaymind/`. Plugin files are
 * source-of-truth — overwritten on every run so bundle updates land
 * deterministically. Hook scripts are chmodded 0755.
 */
export async function installPluginBundle(paths: RelayMindPaths): Promise<InstallPluginBundleResult> {
  const bundleRoot = await resolveRelayMindBundle()
  if (!bundleRoot) {
    // Bundle source unresolvable — leave any previously-installed copy
    // intact. Wiping `dest` here would silently destroy a working install
    // on a re-run from a directory where the resolver cannot find the
    // source tree.
    return { installed: false, bundleRoot: null, filesWritten: 0 }
  }
  const dest = relayMindPluginPath(paths)
  // Wipe the plugin tree so removed bundle files don't linger. Only safe
  // AFTER the bundle source is confirmed available.
  await rm(dest, { recursive: true, force: true })

  const subtrees: ReadonlyArray<readonly [string, CopyOpts]> = [
    ['skills', {}],
    ['hooks', { chmodScripts: true }],
    ['context', {}],
    ['.claude-plugin', {}],
  ]
  let total = 0
  for (const [name, opts] of subtrees) {
    const src = path.join(bundleRoot, name)
    if (!(await dirExists(src))) continue
    const written = await copyTree(src, path.join(dest, name), opts)
    total += written.length
  }
  return { installed: true, bundleRoot, filesWritten: total }
}

export interface InstallTelegramPluginResult {
  installed: boolean
  bundleRoot: string | null
  filesWritten: number
}

/**
 * Copy the Telegram plugin (`telegram-plugin-cc/`) into the profile at
 * `.claude/plugins/vibemind-telegram/`. Excludes node_modules, tests, and
 * lockfiles so we don't bloat the profile. PRD §149 requires the official
 * Telegram plugin to be present in the isolated profile.
 */
export async function installTelegramPluginIntoProfile(paths: RelayMindPaths): Promise<InstallTelegramPluginResult> {
  const bundleRoot = await resolveTelegramBundle()
  if (!bundleRoot) {
    // Bundle source unresolvable — leave any previously-installed copy
    // intact. Wiping `dest` here would destroy a working install on a
    // re-run from a directory where the resolver cannot find the source.
    return { installed: false, bundleRoot: null, filesWritten: 0 }
  }
  const dest = telegramPluginPath(paths)
  // Only safe AFTER the bundle source is confirmed available.
  await rm(dest, { recursive: true, force: true })
  const skip = new Set<string>(['node_modules', 'test', 'bun.lock', '.bun.lock'])
  const written = await copyTree(bundleRoot, dest, { skip, chmodScripts: true })
  return { installed: true, bundleRoot, filesWritten: written.length }
}

// ── Settings merge ───────────────────────────────────────────────────────────

interface SettingsHookEntry {
  matcher?: string
  hooks: Array<{ type: 'command'; command: string }>
}

interface SettingsShape {
  permissions?: { allow?: string[]; deny?: string[] }
  hooks?: Record<string, SettingsHookEntry[]>
  env?: Record<string, string>
  [k: string]: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function uniq<T>(arr: readonly T[]): T[] {
  return Array.from(new Set(arr))
}

/**
 * Substitute the `${CLAUDE_PLUGIN_ROOT}` placeholder in every hook command
 * with the absolute install path. Per Agent E note #1: do not rely on
 * Claude Code expanding it — the installer must.
 */
function substitutePluginRoot(fragment: SettingsShape, pluginRoot: string): SettingsShape {
  if (!fragment.hooks) return fragment
  const out: Record<string, SettingsHookEntry[]> = {}
  for (const [event, entries] of Object.entries(fragment.hooks)) {
    out[event] = entries.map((entry) => ({
      ...entry,
      hooks: entry.hooks.map((h) => ({
        ...h,
        command: h.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot),
      })),
    }))
  }
  return { ...fragment, hooks: out }
}

function mergeSettings(existing: SettingsShape, fragment: SettingsShape): SettingsShape {
  const merged: SettingsShape = { ...existing }

  // permissions.allow/deny: union, dedupe. User keys preserved.
  const exPerm = isPlainObject(existing.permissions) ? existing.permissions : {}
  const frPerm = isPlainObject(fragment.permissions) ? fragment.permissions : {}
  const permissions: { allow?: string[]; deny?: string[] } = { ...exPerm }
  if (Array.isArray(frPerm.allow) || Array.isArray(exPerm.allow)) {
    permissions.allow = uniq([...(exPerm.allow ?? []), ...(frPerm.allow ?? [])])
  }
  if (Array.isArray(frPerm.deny) || Array.isArray(exPerm.deny)) {
    permissions.deny = uniq([...(exPerm.deny ?? []), ...(frPerm.deny ?? [])])
  }
  merged.permissions = permissions

  // env: shallow merge — fragment wins per-key.
  merged.env = { ...(existing.env ?? {}), ...(fragment.env ?? {}) }

  // hooks: per-event replace. The installer owns the four lifecycle events
  // (SessionStart/UserPromptSubmit/PreCompact/Stop). Other events the user
  // configured are preserved untouched.
  const hooks: Record<string, SettingsHookEntry[]> = { ...(existing.hooks ?? {}) }
  for (const [event, entries] of Object.entries(fragment.hooks ?? {})) {
    hooks[event] = entries
  }
  merged.hooks = hooks

  return merged
}

export async function writeProfileSettings(paths: RelayMindPaths): Promise<void> {
  await mkdir(paths.claudeProjectDir, { recursive: true })
  const settingsPath = path.join(paths.claudeProjectDir, 'settings.json')

  // Resolve the absolute hooks dir under the profile. This is the path
  // `${CLAUDE_PLUGIN_ROOT}` resolves to once the plugin is copied in.
  const pluginRoot = relayMindPluginPath(paths)

  // Read fragment from the plugin bundle; fall back to a minimal inline
  // fragment so a missing bundle doesn't break installs.
  const bundle = await resolveRelayMindBundle()
  let fragment: SettingsShape
  if (bundle) {
    try {
      const raw = await readFile(path.join(bundle, 'settings.fragment.json'), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      fragment = isPlainObject(parsed) ? (parsed as SettingsShape) : {}
    } catch {
      fragment = inlineFragment()
    }
  } else {
    fragment = inlineFragment()
  }
  // Drop any leading `_comment` key — JSON has no comments and we don't want
  // it landing in user settings.
  delete (fragment as Record<string, unknown>)._comment

  const resolvedFragment = substitutePluginRoot(fragment, pluginRoot)

  // Read existing settings (preserve user-added keys outside our scope).
  let existing: SettingsShape = {}
  if (await fileExists(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isPlainObject(parsed)) existing = parsed as SettingsShape
    } catch {
      // Malformed user settings: replace rather than crash. The doctor will
      // still flag the original parse error history via logs.
      existing = {}
    }
  }

  const merged = mergeSettings(existing, resolvedFragment)
  await atomicWriteJson(settingsPath, merged)
}

// ── Profile-local marketplace (.claude-plugin/marketplace.json) ─────────────

/**
 * Path to the profile-local marketplace.json. Claude Code looks for this at
 * `<cwd>/.claude-plugin/marketplace.json` and uses it to resolve the plugin
 * names referenced by `--dangerously-load-development-channels`.
 */
export function profileMarketplacePath(paths: RelayMindPaths): string {
  return path.join(paths.claudeHome, '.claude-plugin', 'marketplace.json')
}

interface MarketplaceShape {
  name: string
  owner: { name: string }
  plugins: Array<{ name: string; source: string }>
}

/**
 * Write `<claudeHome>/.claude-plugin/marketplace.json` listing both bundled
 * plugins. Sources are relative to the profile cwd (claudeHome), pointing at
 * the directories `installPluginBundle` / `installTelegramPluginIntoProfile`
 * already populate. Atomic + idempotent — no-ops when bytes are unchanged.
 */
export async function writeProfileMarketplace(paths: RelayMindPaths): Promise<boolean> {
  const target = profileMarketplacePath(paths)
  const desired: MarketplaceShape = {
    name: PROFILE_MARKETPLACE_NAME,
    owner: { name: 'RelayMind' },
    plugins: [
      { name: RELAYMIND_PLUGIN_NAME, source: `./.claude/plugins/${RELAYMIND_PLUGIN_DIR}` },
      { name: TELEGRAM_PLUGIN_NAME, source: `./.claude/plugins/${TELEGRAM_PLUGIN_DIR}` },
    ],
  }
  const next = `${JSON.stringify(desired, null, 2)}\n`
  if (await fileExists(target)) {
    try {
      const current = await readFile(target, 'utf8')
      if (current === next) return false
    } catch {
      // Fall through to write.
    }
  }
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, target)
  return true
}

// ── Claude Code trust pre-mark (~/.claude.json) ─────────────────────────────

/**
 * Pre-mark the profile workspace as trusted in Claude Code's user-level
 * config (`~/.claude.json`). Claude Code records workspace trust under
 * `projects.<absolutePath>.hasTrustDialogAccepted = true`; pre-writing it
 * suppresses the interactive "Do you trust this workspace?" dialog that
 * blocks startup inside our headless tmux pane.
 *
 * Best-effort. If `~/.claude.json` is unreadable, malformed, or absent we
 * write a minimal new file with just the trusted-projects entry. Caller
 * still passes `--dangerously-skip-permissions` as belt-and-braces.
 */
export interface PreMarkTrustOpts {
  /** Override the config path. Defaults to `~/.claude.json`. Used by tests. */
  configPath?: string
  /** Override the home dir. Defaults to `os.homedir()`. Used by tests. */
  homeDir?: string
}

export interface PreMarkTrustResult {
  ok: boolean
  configPath: string
  changed: boolean
  detail?: string
}

interface ClaudeUserConfig {
  projects?: Record<string, Record<string, unknown>>
  [k: string]: unknown
}

export async function preMarkWorkspaceTrusted(
  paths: RelayMindPaths,
  opts: PreMarkTrustOpts = {},
): Promise<PreMarkTrustResult> {
  const { homedir } = await import('node:os')
  const envOverride = process.env.RELAYMIND_CLAUDE_CONFIG_PATH
  const configPath =
    opts.configPath
    ?? (envOverride && envOverride !== '' ? envOverride : path.join(opts.homeDir ?? homedir(), '.claude.json'))
  const workspace = paths.claudeHome

  let cfg: ClaudeUserConfig = {}
  if (await fileExists(configPath)) {
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isPlainObject(parsed)) cfg = parsed as ClaudeUserConfig
    } catch (err) {
      // Malformed user config — refuse to clobber. Surface the failure so
      // the caller can warn rather than silently overwriting unrelated keys.
      return {
        ok: false,
        configPath,
        changed: false,
        detail: `parse error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  const projects: Record<string, Record<string, unknown>> = isPlainObject(cfg.projects)
    ? (cfg.projects as Record<string, Record<string, unknown>>)
    : {}
  const existing = isPlainObject(projects[workspace]) ? projects[workspace] : {}
  if (existing.hasTrustDialogAccepted === true) {
    return { ok: true, configPath, changed: false, detail: 'already trusted' }
  }
  projects[workspace] = { ...existing, hasTrustDialogAccepted: true }
  cfg.projects = projects

  // Atomic write — never leave the user's main config half-written.
  await mkdir(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp`
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  await rename(tmp, configPath)
  return { ok: true, configPath, changed: true }
}

export interface IsolatedClaudeConfigResult {
  ok: boolean
  settingsPath: string
  changed: boolean
  detail?: string
}

/**
 * Populate the isolated Claude Code config dir (`CLAUDE_CONFIG_DIR`) so the
 * supervisor-launched session sees a FRESH global root with only RelayMind's
 * marketplace + plugins — no user settings, no user plugins, no user
 * CLAUDE.md walk-up, no user trust state.
 *
 * Writes `<paths.claudeConfigSettings>`:
 *   - `extraKnownMarketplaces.vibemind-local.source` → directory pointing
 *     at the profile's claude-home (where `.claude-plugin/marketplace.json`
 *     lives, listing both bundled plugins).
 *   - `enabledPlugins.vibemind-relaymind@vibemind-local` = true
 *   - `enabledPlugins.vibemind-telegram@vibemind-local` = true
 *
 * Atomic. Idempotent — re-runs preserve any user-added keys in the isolated
 * settings file (which the user might add to override defaults).
 */
export async function writeIsolatedClaudeConfig(
  paths: RelayMindPaths,
): Promise<IsolatedClaudeConfigResult> {
  const settingsPath = paths.claudeConfigSettings

  let cfg: Record<string, unknown> = {}
  if (await fileExists(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isPlainObject(parsed)) cfg = parsed as Record<string, unknown>
    } catch (err) {
      return {
        ok: false,
        settingsPath,
        changed: false,
        detail: `parse error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  const before = JSON.stringify(cfg)

  const markets = isPlainObject(cfg.extraKnownMarketplaces)
    ? (cfg.extraKnownMarketplaces as Record<string, unknown>)
    : {}
  markets[PROFILE_MARKETPLACE_NAME] = {
    source: { source: 'directory', path: paths.claudeHome },
  }
  cfg.extraKnownMarketplaces = markets

  const enabled: Record<string, boolean> = isPlainObject(cfg.enabledPlugins)
    ? (cfg.enabledPlugins as Record<string, boolean>)
    : {}
  enabled[`${TELEGRAM_PLUGIN_NAME}@${PROFILE_MARKETPLACE_NAME}`] = true
  enabled[`${RELAYMIND_PLUGIN_NAME}@${PROFILE_MARKETPLACE_NAME}`] = true
  cfg.enabledPlugins = enabled

  // Hooks live in the GLOBAL config in Claude Code 2.x — project-local
  // settings.json hooks are not always honored. Wire them here, with
  // absolute paths to the installed plugin's hook scripts so they fire
  // regardless of cwd resolution.
  const hooksDir = path.join(paths.claudeProjectDir, 'plugins', RELAYMIND_PLUGIN_DIR, 'hooks')
  const hookCommand = (script: string) => `bash ${path.join(hooksDir, script)}`
  cfg.hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('session-start.sh') }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand('user-prompt-submit.sh') }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: hookCommand('pre-compact.sh') }] }],
    Stop: [{ hooks: [{ type: 'command', command: hookCommand('stop.sh') }] }],
  }

  const after = JSON.stringify(cfg)
  if (before === after && (await fileExists(settingsPath))) {
    return { ok: true, settingsPath, changed: false, detail: 'already up to date' }
  }

  await mkdir(paths.claudeConfigDir, { recursive: true })
  const tmp = `${settingsPath}.tmp`
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  await rename(tmp, settingsPath)
  return { ok: true, settingsPath, changed: true }
}

function inlineFragment(): SettingsShape {
  return {
    permissions: {
      allow: [
        'Bash(viberelay relaymind *)',
        'Bash(viberelay telegram *)',
        'Bash(viberelay status*)',
        'Bash(viberelay usage*)',
        'Read(./**)',
        'Write(./**)',
        `Plugin:${TELEGRAM_PLUGIN_NAME}@${PROFILE_MARKETPLACE_NAME}`,
        `Plugin:${RELAYMIND_PLUGIN_NAME}@${PROFILE_MARKETPLACE_NAME}`,
      ],
      deny: ['Bash(rm -rf *)', 'Bash(sudo *)'],
    },
    env: { VIBERELAY_RELAYMIND_PROFILE: '1' },
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh' }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.sh' }] },
      ],
      PreCompact: [
        { hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-compact.sh' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh' }] }],
    },
  }
}

// ── Deprecated stub installers (kept for compatibility) ──────────────────────

/**
 * Deprecated: skill payloads now live in the plugin bundle and are copied
 * by `installPluginBundle`. Kept as a no-op so legacy callers and tests
 * keep working through the deprecation window.
 */
export async function installSkillStubs(_paths: RelayMindPaths): Promise<void> {
  // Intentionally empty. Plugin bundle governs skills.
}

/**
 * Deprecated: hook payloads now live in the plugin bundle and are copied
 * by `installPluginBundle`. Kept as a no-op so legacy callers and tests
 * keep working.
 */
export async function installHookStubs(_paths: RelayMindPaths): Promise<void> {
  // Intentionally empty. Plugin bundle governs hooks.
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean
  issues: string[]
}

const REQUIRED_HOOK_SCRIPTS = ['session-start.sh', 'user-prompt-submit.sh', 'pre-compact.sh', 'stop.sh'] as const
const REQUIRED_SKILL_SLUGS = [
  'relaymind-memory',
  'relaymind-checkpoint',
  'relaymind-daily',
  'relaymind-self-heal',
  'relaymind-commands',
] as const

export async function verifyInstallation(paths: RelayMindPaths): Promise<VerifyResult> {
  const issues: string[] = []

  const requiredDirs: Array<readonly [string, string]> = [
    ['stateRoot', paths.stateRoot],
    ['claudeHome', paths.claudeHome],
    ['claudeProjectDir', paths.claudeProjectDir],
    ['commandsDir', paths.commandsDir],
    ['handlersDir', paths.handlersDir],
    ['skillsDir', paths.skillsDir],
    ['hooksDir', paths.hooksDir],
    ['dailyDir', paths.dailyDir],
    ['supervisorStateDir', paths.supervisorStateDir],
  ]
  for (const [label, dir] of requiredDirs) {
    try {
      const s = await stat(dir)
      if (!s.isDirectory()) issues.push(`${label}: not a directory (${dir})`)
    } catch {
      issues.push(`${label}: missing (${dir})`)
    }
  }

  const requiredFiles: Array<readonly [string, string]> = [
    ['SOUL.md', paths.soulMd],
    ['TOOLS.md', paths.toolsMd],
    ['CLAUDE.md', paths.claudeMd],
    ['MEMORY.md', paths.memoryMd],
    ['registry.json', paths.registryJson],
    ['config.json', paths.configJson],
    ['.claude/settings.json', path.join(paths.claudeProjectDir, 'settings.json')],
    ['.claude-plugin/marketplace.json', profileMarketplacePath(paths)],
  ]
  for (const [label, file] of requiredFiles) {
    if (!(await fileExists(file))) issues.push(`${label}: missing (${file})`)
  }

  // CLAUDE.md must contain the RelayMind markers (Agent E note #2).
  if (await fileExists(paths.claudeMd)) {
    const claudeContent = await readFile(paths.claudeMd, 'utf8')
    if (!claudeContent.includes(CLAUDE_BEGIN) || !claudeContent.includes(CLAUDE_END)) {
      issues.push('CLAUDE.md: missing RelayMind BEGIN/END markers')
    }
  }

  // Plugin bundle must be present in the profile.
  const pluginDir = relayMindPluginPath(paths)
  if (!(await dirExists(pluginDir))) {
    issues.push(`plugin bundle: missing (${pluginDir})`)
  } else {
    for (const slug of REQUIRED_SKILL_SLUGS) {
      const f = path.join(pluginDir, 'skills', slug, 'SKILL.md')
      if (!(await fileExists(f))) issues.push(`plugin skill ${slug}: missing SKILL.md`)
    }
    for (const script of REQUIRED_HOOK_SCRIPTS) {
      const f = path.join(pluginDir, 'hooks', script)
      if (!(await fileExists(f))) issues.push(`plugin hook ${script}: missing`)
    }
  }

  // Telegram plugin should be present in the profile (PRD §149) — but only
  // flag it if the source bundle exists. Users who install RelayMind without
  // the telegram bundle won't trip this check.
  const telegramSource = await resolveTelegramBundle()
  if (telegramSource) {
    const tgDir = telegramPluginPath(paths)
    if (!(await dirExists(tgDir))) {
      issues.push(`telegram plugin: missing in profile (${tgDir})`)
    }
  }

  // Settings hooks must reference absolute paths (no unresolved
  // ${CLAUDE_PLUGIN_ROOT}).
  const settingsPath = path.join(paths.claudeProjectDir, 'settings.json')
  if (await fileExists(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as SettingsShape
      const hooks = parsed.hooks ?? {}
      for (const [event, entries] of Object.entries(hooks)) {
        for (const entry of entries) {
          for (const h of entry.hooks) {
            if (h.command.includes('${CLAUDE_PLUGIN_ROOT}')) {
              issues.push(`settings.json hook ${event}: unresolved \${CLAUDE_PLUGIN_ROOT}`)
            }
          }
        }
      }
    } catch (err) {
      issues.push(`settings.json: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  // Registry must parse and contain a `commands` array.
  if (await fileExists(paths.registryJson)) {
    try {
      const raw = await readFile(paths.registryJson, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { commands?: unknown }).commands)) {
        issues.push('registry.json: missing "commands" array')
      }
    } catch (err) {
      issues.push(`registry.json: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  return { ok: issues.length === 0, issues }
}

// ── Internal exports for tests ───────────────────────────────────────────────

export const _internal = {
  CLAUDE_BEGIN,
  CLAUDE_END,
}
