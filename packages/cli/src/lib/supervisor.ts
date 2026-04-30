/**
 * RelayMind supervisor — process lifecycle for the persistent Claude Code
 * session, wrapped inside a long-lived `tmux` session.
 *
 * Why tmux? Claude Code is interactive — it wants a real PTY. The previous
 * detached/stdio:'ignore' approach gave it no TTY, which made it EOF on
 * launch and rendered slash commands unusable. tmux owns supervision (it
 * survives our crashes), gives Claude a real PTY, and lets us `attach` for
 * debugging or `send-keys` for programmatic input (self-edit restart flows).
 *
 * Responsibilities (PRD §"Runtime Start Flow", §"Self-Editing and Self-Healing"):
 *   - launch `claude` inside a tmux session with the isolated profile cwd + env
 *     (DECISIONS.md §D2)
 *   - persist pid (the tmux pane child pid, telemetry only) +
 *     SupervisorSessionMeta atomically
 *   - stop with `C-c` flush → kill-session
 *   - single-shot health check (a real watchdog is Wave-3)
 *   - snapshot / rollback the command registry — rollback can never silently
 *     no-op (PRD §867-877)
 *
 * Hard rules: Node stdlib only, no `any`, no new npm deps. `tmux` arguments
 * are always passed as a discrete `args` array to `execFile` — never shell-
 * interpolated, so user-provided session names and send-keys text cannot
 * inject shell metacharacters.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import type {
  RelayMindPaths,
  SupervisorHealth,
  SupervisorSessionMeta,
  SupervisorStatus,
} from '@viberelay/shared/relaymind'
import {
  PROFILE_MARKETPLACE_NAME,
  RELAYMIND_PLUGIN_NAME,
  TELEGRAM_PLUGIN_NAME,
} from './profile-installer.js'

const execFileAsync = promisify(execFile)

// ─── Public types ───────────────────────────────────────────────────────────

/** Result of a tmux invocation. Mirrors what we need from execFile. */
export interface TmuxResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** DI for tmux. Tests inject a stub; real callers leave it unset. */
export type TmuxFn = (args: readonly string[]) => Promise<TmuxResult>

export interface StartOptions {
  /** Override the session name (defaults to config.json or `relaymind-main`). */
  sessionName?: string
  /** Resume the previously recorded Claude session id when present. */
  resume?: boolean
  /** Path to the claude binary. Defaults to `claude` on PATH. Used by the bare-claude fallback. */
  claudeBin?: string
  /** Path to the viberelay binary. Defaults to `viberelay` on PATH. */
  viberelayBin?: string
  /**
   * Override the viberelay profile name. When unset, read from
   * `config.viberelayProfile.name`. When the named profile cannot be
   * resolved, the supervisor falls back to bare `claude` and emits a
   * warning in the supervisor log.
   */
  viberelayProfile?: string
  /**
   * Override the directory where viberelay profiles live. Useful for tests
   * (read directly from `VIBERELAY_PROFILES_DIR` otherwise).
   */
  viberelayProfilesDir?: string
  /** Path to the tmux binary. Defaults to `tmux` on PATH. */
  tmuxBin?: string
  /** Injected for tests. */
  tmuxFn?: TmuxFn
  /**
   * Injected for tests — checks whether a viberelay profile file exists.
   * Real callers leave this unset (we stat the resolved file).
   */
  profileExists?: (profileFile: string) => Promise<boolean>
  /**
   * Extra args appended verbatim to the claude command line. Useful for
   * advanced configs (extra `--dangerously-load-development-channels`
   * selectors, model overrides, etc.) without forking the supervisor.
   */
  extraClaudeArgs?: readonly string[]
}

export interface StopOptions {
  /** Grace ms to wait between Ctrl-C and kill-session. Default 2_000. */
  graceMs?: number
  /** Path to the tmux binary. Defaults to `tmux` on PATH. */
  tmuxBin?: string
  /** Injected for tests. */
  tmuxFn?: TmuxFn
}

export interface RestartOptions extends StartOptions, StopOptions {
  /** Reserved — Wave-2 will use this for the Telegram-plugin-only restart. */
  pluginOnly?: boolean
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SESSION_NAME = 'relaymind-main'
const DEFAULT_GRACE_MS = 2_000
/** Transcript silent for >5 min => unhealthy. */
const TRANSCRIPT_STALENESS_MS = 5 * 60_000

const LOG_FILE = 'supervisor.log'

// ─── tmux abstraction ───────────────────────────────────────────────────────

/**
 * Run tmux with the given args. Returns exit code + captured streams instead
 * of throwing on non-zero — many tmux verbs (`has-session`, `kill-session`)
 * use exit codes to communicate "session missing", which is a normal flow.
 */
export function makeTmuxFn(tmuxBin: string): TmuxFn {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync(tmuxBin, [...args])
      return { exitCode: 0, stdout, stderr }
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        code?: number | string
        stdout?: string
        stderr?: string
      }
      // ENOENT: tmux not on PATH. Re-throw with a friendlier message.
      if (e.code === 'ENOENT') {
        throw new Error(
          `tmux not found on PATH (looked for '${tmuxBin}'). Install: brew install tmux  /  apt install tmux`,
        )
      }
      // Non-zero exit. execFile gives us the numeric exit code on `code` when
      // it's a Number. When it's not (e.g. a string ENOENT-class code), we
      // bubble up — but we already handled ENOENT above.
      const exitCode = typeof e.code === 'number' ? e.code : 1
      return {
        exitCode,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? (e instanceof Error ? e.message : String(err)),
      }
    }
  }
}

function resolveTmux(opts: { tmuxFn?: TmuxFn; tmuxBin?: string }): TmuxFn {
  return opts.tmuxFn ?? makeTmuxFn(opts.tmuxBin ?? 'tmux')
}

/** Probe for tmux on PATH. Used by doctor. */
export async function tmuxAvailable(opts: { tmuxBin?: string; tmuxFn?: TmuxFn } = {}): Promise<boolean> {
  const tmux = resolveTmux(opts)
  try {
    const r = await tmux(['-V'])
    return r.exitCode === 0
  } catch {
    return false
  }
}

async function hasTmuxSession(tmux: TmuxFn, name: string): Promise<boolean> {
  const r = await tmux(['has-session', '-t', name])
  return r.exitCode === 0
}

// ─── File / state helpers ───────────────────────────────────────────────────

async function atomicWrite(target: string, data: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, target)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function logPath(paths: RelayMindPaths): string {
  return path.join(paths.supervisorStateDir, LOG_FILE)
}

async function appendLog(paths: RelayMindPaths, line: string): Promise<void> {
  await mkdir(paths.supervisorStateDir, { recursive: true })
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  // Append-only — log lines are intentionally additive and tolerant of
  // partial writes, hence not write-then-rename.
  const { appendFile } = await import('node:fs/promises')
  await appendFile(logPath(paths), stamped, 'utf8')
}

async function loadSessionMeta(
  paths: RelayMindPaths,
): Promise<SupervisorSessionMeta | null> {
  return readJson<SupervisorSessionMeta>(paths.sessionFile)
}

async function loadSessionName(paths: RelayMindPaths): Promise<string> {
  const meta = await loadSessionMeta(paths)
  if (meta?.sessionName) return meta.sessionName
  const cfg = await readJson<{ sessionName?: string }>(paths.configJson)
  return cfg?.sessionName ?? DEFAULT_SESSION_NAME
}

async function writeSessionMeta(
  paths: RelayMindPaths,
  meta: SupervisorSessionMeta,
): Promise<void> {
  await atomicWrite(paths.sessionFile, JSON.stringify(meta, null, 2))
}

// ─── startSession ───────────────────────────────────────────────────────────

/**
 * Build the tmux command we use to launch the runner. Exposed for tests +
 * documentation. Two shapes — profile-driven (preferred) and bare-claude
 * fallback:
 *
 *   # profile-driven (multi-account / model groups)
 *   tmux new-session -d -s <name> -c <cwd> \
 *     -e CLAUDE_PROJECT_DIR=<...> -e VIBERELAY_RELAYMIND_PROFILE=1 \
 *     -- <viberelayBin> run <profile> -- <claudeArgs...>
 *
 *   # bare-claude fallback
 *   tmux new-session -d -s <name> -c <cwd> \
 *     -e CLAUDE_PROJECT_DIR=<...> -e VIBERELAY_RELAYMIND_PROFILE=1 \
 *     -- <claudeBin> <claudeArgs...>
 *
 * `<claudeArgs...>` comes from `buildClaudeArgs()` — see its doc for the
 * exact shape.
 */
function buildNewSessionArgs(input: {
  sessionName: string
  cwd: string
  env: Record<string, string>
  runnerBin: string
  /** Args inserted between the runner bin and the `--` separator. */
  runnerArgs: readonly string[]
  /**
   * Args after the `--` separator. For the viberelay-run path these are the
   * pass-through claude args; for the bare-claude path the runnerArgs
   * already contain everything and this is empty.
   */
  trailingArgs: readonly string[]
}): string[] {
  const args: string[] = ['new-session', '-d', '-s', input.sessionName, '-c', input.cwd]
  for (const [k, v] of Object.entries(input.env)) {
    args.push('-e', `${k}=${v}`)
  }
  // First `--` ends tmux's option parsing so a future runner flag that looks
  // like a tmux option can't be misinterpreted.
  args.push('--', input.runnerBin, ...input.runnerArgs)
  if (input.trailingArgs.length > 0) {
    // The second `--` (between profile-runner and claude flags) is added by
    // the caller via trailingArgs[0], not synthesized here, so the bare path
    // doesn't accidentally inject one.
    args.push(...input.trailingArgs)
  }
  return args
}

interface ResolvedRunner {
  /** The binary tmux launches (viberelay or claude). */
  runnerBin: string
  /** Args between runnerBin and the `--` separator. */
  runnerArgs: string[]
  /** Args after the `--` separator (claude flags forwarded by viberelay run). */
  trailingArgs: string[]
  /** Human-readable note for the supervisor log: 'profile=<name>' or 'bare-claude'. */
  modeNote: string
  /** When falling back, this is non-empty so the caller can warn. */
  fallbackWarning: string | null
}

function resolveProfilesDir(override?: string): string {
  return override ?? process.env.VIBERELAY_PROFILES_DIR ?? path.join(homedir(), '.viberelay', 'profiles')
}

async function defaultProfileExists(profileFile: string): Promise<boolean> {
  try {
    await access(profileFile, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Build the claude argv the supervisor passes to either `viberelay run` (via
 * `-- ...`) or bare `claude`. Exposed for tests + documentation.
 *
 * Shape (Claude Code 2.x):
 *
 *   [--resume <id>] \
 *   --dangerously-load-development-channels plugin:vibemind-telegram@vibemind-local \
 *   --dangerously-load-development-channels plugin:vibemind-relaymind@vibemind-local \
 *   --dangerously-skip-permissions
 *   [...extra]
 *
 * Notes:
 *   - No `--name` flag — Claude Code 2.x doesn't accept one; the tmux session
 *     name is how we address the process.
 *   - `--resume` is only emitted when we actually have a prior session id (or
 *     the caller opted in with `resume=true`, in which case we pass bare
 *     `--resume` so claude resumes the most-recent session). Passing
 *     `--resume` on a fresh install with no prior id can hang on a picker.
 *   - Both plugins are loaded via `--dangerously-load-development-channels`
 *     so Claude Code resolves them against the profile-local
 *     `.claude-plugin/marketplace.json`.
 *   - `--dangerously-skip-permissions` disables the per-tool permission
 *     prompts AND covers the workspace-trust dialog (we ALSO pre-mark the
 *     workspace as trusted in `~/.claude.json` for belt-and-braces).
 */
export function buildClaudeArgs(input: {
  resumeArgs: readonly string[]
  /** Display name for the tmux pane prompt + /resume picker. */
  sessionName?: string
  extra?: readonly string[]
  /**
   * When true, omit `--dangerously-skip-permissions` because the runner
   * (viberelay run -d) injects it itself. Bare-claude path needs it included.
   */
  skipPermsInjectedByRunner?: boolean
}): string[] {
  // Plugin loading goes through `enabledPlugins` in
  // `<CLAUDE_CONFIG_DIR>/settings.json` (populated by `writeIsolatedClaudeConfig`).
  //
  // The `--channels` flag is the EXPERIMENTAL Claude Code mechanism that
  // opens push-message intake for a plugin's channel. It is NOT documented
  // in `claude --help` but it IS honored — without it, the telegram plugin
  // server can listen for Telegram updates but they never reach the
  // session. (The previous `--dangerously-load-development-channels` flag
  // was a bogus name that Claude silently ignores; do not bring it back.)
  //
  // We only emit `--channels` for the telegram plugin — that's the only
  // bundled plugin that exposes an inbound channel. The relaymind plugin
  // ships skills + hooks only, no channel.
  const nameArgs = input.sessionName ? ['--name', input.sessionName] : []
  const channelArgs = [
    '--channels',
    `plugin:${TELEGRAM_PLUGIN_NAME}@${PROFILE_MARKETPLACE_NAME}`,
  ]
  return [
    ...nameArgs,
    ...input.resumeArgs,
    ...channelArgs,
    ...(input.skipPermsInjectedByRunner ? [] : ['--dangerously-skip-permissions']),
    ...(input.extra ?? []),
  ]
}

/**
 * Resolve which runner the supervisor should launch. Reads the configured
 * viberelay profile, validates that its profile file exists, and falls back
 * to bare claude with a warning when it doesn't.
 */
async function resolveRunner(
  paths: RelayMindPaths,
  opts: StartOptions,
  sessionName: string,
  resumeArgs: readonly string[],
): Promise<ResolvedRunner> {
  const claudeBin = opts.claudeBin ?? 'claude'
  const viberelayBin = opts.viberelayBin ?? 'viberelay'

  // Read launchMode from config — defaults to 'isolated'. See
  // RelayMindLaunchMode docs in types.ts for the trade-off.
  //
  // 'passthrough' means: STILL go through viberelay proxy (multi-account
  // routing), but DON'T redirect CLAUDE_CONFIG_DIR. Claude reads the
  // user's `~/.claude/.credentials.json` for session OAuth (channels
  // gate passes), while model API calls still flow through viberelay.
  // The CLAUDE_CONFIG_DIR skip happens in startSession via launchMode.
  // (Tagged on the runner via modeNote so the env-shaping branch can see it.)
  const bareClaudeFlags = buildClaudeArgs({ resumeArgs, sessionName, extra: opts.extraClaudeArgs })

  // Read profile binding from config.json (if any). Failure to read or
  // parse falls through to bare-claude — config is best-effort here.
  let profileName = opts.viberelayProfile
  if (!profileName) {
    try {
      const cfg = (await readJson<{
        viberelayProfile?: { name?: string }
      }>(paths.configJson)) ?? null
      profileName = cfg?.viberelayProfile?.name
    } catch {
      profileName = undefined
    }
  }

  if (!profileName) {
    return {
      runnerBin: claudeBin,
      runnerArgs: bareClaudeFlags,
      trailingArgs: [],
      modeNote: 'bare-claude (no profile configured)',
      fallbackWarning: null,
    }
  }

  const profilesDir = resolveProfilesDir(opts.viberelayProfilesDir)
  const profileFile = path.join(profilesDir, `${profileName}.json`)
  const exists = (opts.profileExists ?? defaultProfileExists)
  if (!(await exists(profileFile))) {
    return {
      runnerBin: claudeBin,
      runnerArgs: bareClaudeFlags,
      trailingArgs: [],
      modeNote: `bare-claude (profile '${profileName}' not found)`,
      fallbackWarning: `viberelay profile '${profileName}' not found at ${profileFile}; running claude directly without multi-account fallback. Run 'relaymind setup' to fix.`,
    }
  }

  // Profile-driven path: `viberelay run -d <profile> <claude flags...>`
  // The `-d` is consumed by runProfile in profile.ts which sets dangerous=true
  // and triggers `--dangerously-skip-permissions` injection on the claude
  // child — so we DON'T add the flag ourselves (would be a no-op duplicate).
  // No `--` separator: runProfile slices args.slice(idx+1) verbatim into
  // claude's argv, and a leading `--` would reach claude where it means
  // "end of options" and turn every following flag into prompt text.
  const profileClaudeFlags = buildClaudeArgs({
    resumeArgs,
    sessionName,
    extra: opts.extraClaudeArgs,
    skipPermsInjectedByRunner: true,
  })
  return {
    runnerBin: viberelayBin,
    runnerArgs: ['run', '-d', profileName],
    trailingArgs: profileClaudeFlags,
    modeNote: `profile=${profileName}`,
    fallbackWarning: null,
  }
}

export async function startSession(
  paths: RelayMindPaths,
  opts: StartOptions = {},
): Promise<SupervisorSessionMeta> {
  const tmux = resolveTmux(opts)

  if (!(await tmuxAvailable({ tmuxFn: tmux }))) {
    throw new Error(
      "tmux not found on PATH. RelayMind requires tmux to host the Claude Code session. Install: 'brew install tmux' (macOS) or 'apt install tmux' (Linux).",
    )
  }

  const previous = await loadSessionMeta(paths)
  const sessionName =
    opts.sessionName ?? previous?.sessionName ?? (await loadSessionName(paths))

  // If a tmux session is already running for this name, refuse rather than
  // double-starting. Stop first if you want to restart.
  if (await hasTmuxSession(tmux, sessionName)) {
    throw new Error(
      `tmux session '${sessionName}' already running — call stopSession() or restartSession() first`,
    )
  }

  // Resume args (claude side) — passed through whether we go via viberelay
  // run or bare claude. The viberelay-run path forwards them after `--`.
  const resumeArgs: string[] = []
  if (opts.resume && previous?.claudeSessionId) {
    resumeArgs.push('--resume', previous.claudeSessionId)
  } else if (opts.resume) {
    // No recorded session id yet — still pass `--resume` so Claude resumes
    // the most-recent session under that name if one exists.
    resumeArgs.push('--resume')
  }

  const runner = await resolveRunner(paths, opts, sessionName, resumeArgs)

  // Read launchMode for env shaping. Default 'isolated'. Documented in types.ts.
  let launchMode: 'isolated' | 'passthrough' = 'isolated'
  try {
    const cfg = await readJson<{ launchMode?: 'isolated' | 'passthrough' }>(paths.configJson)
    if (cfg?.launchMode === 'passthrough') launchMode = 'passthrough'
  } catch {
    /* default isolated */
  }
  const isPassthrough = launchMode === 'passthrough'

  // Resolve Telegram token. The plugin reads `TELEGRAM_BOT_TOKEN`; we accept
  // a few synonyms so users can `export VIBERELAY_RELAYMIND_TOKEN=...` and
  // not have to also re-export under the plugin's name.
  const telegramToken =
    process.env.TELEGRAM_BOT_TOKEN
    ?? process.env.VIBERELAY_RELAYMIND_TOKEN
    ?? process.env.RELAYMIND_TELEGRAM_TOKEN

  // launchMode determines whether we redirect CLAUDE_CONFIG_DIR. In
  // passthrough mode the user's `~/.claude/` (with their OAuth creds + the
  // working tengu_harbor account context) is what we want — redirecting
  // would lose creds and re-close the channels gate.
  const env: Record<string, string> = {
    CLAUDE_PROJECT_DIR: paths.claudeHome,
    VIBERELAY_RELAYMIND_PROFILE: '1',
    // Profile-isolate the Telegram plugin's state — without this it shares
    // `~/.claude/channels/telegram/` with every other Claude Code workspace
    // and your other bot's pairings/allowlist/token leak in.
    TELEGRAM_STATE_DIR: paths.telegramStateDir,
    // Mirror inbound messages to <telegramStateDir>/messages/ so the
    // relaymind bridge worker (`relaymind bridge start`) can deliver them
    // to Claude — works around Anthropic issue #36503 where the
    // tengu_harbor channel gate silently blocks notifications/claude/channel.
    // The bridge is opt-in; if you don't run it the mirror files just
    // accumulate harmlessly until the gate ever opens.
    TELEGRAM_BRIDGE_MODE: 'file-mirror',
    // Full Claude Code isolation: redirect the *global* config root from
    // `~/.claude/` to a profile-local dir. Without this, Claude reads the
    // user's normal settings.json (every plugin they've enabled, every
    // marketplace they've registered), `.claude.json` (project list,
    // trust state), and walks parents for CLAUDE.md. The isolated dir is
    // populated by the installer with our marketplace + enabledPlugins.
    // In passthrough mode we DON'T redirect — the user's OAuth creds in
    // `~/.claude/.credentials.json` are required for channels to work
    // (Anthropic's tengu_harbor gate, issue #36503).
    ...(isPassthrough ? {} : { CLAUDE_CONFIG_DIR: paths.claudeConfigDir }),
  }
  if (telegramToken) {
    env.TELEGRAM_BOT_TOKEN = telegramToken
  }

  await mkdir(paths.telegramStateDir, { recursive: true })

  await mkdir(paths.supervisorStateDir, { recursive: true })

  if (runner.fallbackWarning) {
    await appendLog(paths, `start warn ${runner.fallbackWarning}`)
  }

  const newSessionArgs = buildNewSessionArgs({
    sessionName,
    cwd: paths.claudeHome,
    env,
    runnerBin: runner.runnerBin,
    runnerArgs: runner.runnerArgs,
    trailingArgs: runner.trailingArgs,
  })
  const launch = await tmux(newSessionArgs)
  if (launch.exitCode !== 0) {
    throw new Error(
      `tmux new-session failed (exit ${launch.exitCode}): ${launch.stderr.trim() || launch.stdout.trim()}`,
    )
  }

  // Telemetry pid: the pid of claude inside the tmux pane. tmux itself owns
  // supervision; this number is purely informational.
  const panes = await tmux(['list-panes', '-t', sessionName, '-F', '#{pane_pid}'])
  const pid =
    panes.exitCode === 0
      ? Number.parseInt(panes.stdout.trim().split('\n')[0] ?? '', 10)
      : Number.NaN
  const recordedPid = Number.isInteger(pid) && pid > 0 ? pid : 0

  const meta: SupervisorSessionMeta = {
    sessionName,
    claudeSessionId: previous?.claudeSessionId,
    pid: recordedPid,
    startedAt: new Date().toISOString(),
    transcriptPath: previous?.transcriptPath,
    status: 'starting',
  }

  await atomicWrite(paths.pidFile, `${recordedPid}\n`)
  await writeSessionMeta(paths, meta)
  await appendLog(
    paths,
    `start tmux=${sessionName} pid=${recordedPid} resume=${opts.resume === true} runner=${runner.modeNote}`,
  )

  return meta
}

// ─── stopSession ────────────────────────────────────────────────────────────

export async function stopSession(
  paths: RelayMindPaths,
  opts: StopOptions = {},
): Promise<{ stopped: boolean; pid: number | null }> {
  const tmux = resolveTmux(opts)
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS

  const sessionName = await loadSessionName(paths)
  const meta = await loadSessionMeta(paths)
  const recordedPid = meta?.pid ?? null

  const present = await hasTmuxSession(tmux, sessionName)
  if (!present) {
    // Idempotent: nothing live to do — but normalize state.
    await rm(paths.pidFile, { force: true })
    if (meta && meta.status !== 'stopped') {
      await writeSessionMeta(paths, { ...meta, status: 'stopped' })
    }
    await appendLog(paths, `stop noop=no-tmux-session name=${sessionName}`)
    return { stopped: false, pid: recordedPid }
  }

  // Send Ctrl-C to let Claude flush, then kill the session.
  const ctrlC = await tmux(['send-keys', '-t', sessionName, 'C-c'])
  if (ctrlC.exitCode !== 0) {
    await appendLog(paths, `stop ctrl-c-failed name=${sessionName} err=${ctrlC.stderr.trim()}`)
  }
  await new Promise((r) => setTimeout(r, grace))
  const kill = await tmux(['kill-session', '-t', sessionName])
  if (kill.exitCode !== 0) {
    await appendLog(paths, `stop kill-failed name=${sessionName} err=${kill.stderr.trim()}`)
  } else {
    await appendLog(paths, `stop ok name=${sessionName} pid=${recordedPid ?? '?'}`)
  }

  await rm(paths.pidFile, { force: true })
  if (meta) await writeSessionMeta(paths, { ...meta, status: 'stopped' })

  return { stopped: kill.exitCode === 0, pid: recordedPid }
}

// ─── restartSession ─────────────────────────────────────────────────────────

export async function restartSession(
  paths: RelayMindPaths,
  opts: RestartOptions = {},
): Promise<SupervisorSessionMeta> {
  if (opts.pluginOnly) {
    // Reserved for Wave-2: telegram-plugin-only restart that keeps the Claude
    // process alive. Currently a no-op so callers can stage the flag.
    await appendLog(paths, 'restart plugin-only=true (no-op in Wave-1)')
    const meta = await loadSessionMeta(paths)
    if (meta) return meta
    // Fall through to normal start if there's nothing to preserve.
  }

  await stopSession(paths, opts)
  return startSession(paths, { ...opts, resume: true })
}

// ─── Health / status ────────────────────────────────────────────────────────

export async function getStatus(
  paths: RelayMindPaths,
  opts: { tmuxFn?: TmuxFn; tmuxBin?: string } = {},
): Promise<{
  health: SupervisorHealth
  meta: SupervisorSessionMeta | null
}> {
  const tmux = resolveTmux(opts)
  const checkedAt = new Date().toISOString()
  const meta = await loadSessionMeta(paths)

  // No meta => stopped. Don't probe tmux: there's nothing to ask about.
  if (!meta) {
    return { health: { status: 'stopped', checkedAt }, meta: null }
  }

  const present = await hasTmuxSession(tmux, meta.sessionName)
  if (!present) {
    return {
      health: { status: 'stopped', checkedAt, detail: 'no tmux session' },
      meta: { ...meta, status: 'stopped' },
    }
  }

  // tmux session exists but transcript hasn't been touched recently => unhealthy.
  if (meta.transcriptPath) {
    try {
      const s = await stat(meta.transcriptPath)
      const age = Date.now() - s.mtime.getTime()
      if (age > TRANSCRIPT_STALENESS_MS) {
        return {
          health: {
            status: 'unhealthy',
            checkedAt,
            detail: `transcript silent for ${Math.round(age / 1000)}s`,
          },
          meta: { ...meta, status: 'unhealthy' },
        }
      }
    } catch {
      // Transcript path recorded but missing — treat as unhealthy, not stopped:
      // tmux is still alive, we just lost the file.
      return {
        health: {
          status: 'unhealthy',
          checkedAt,
          detail: 'transcript path missing',
        },
        meta: { ...meta, status: 'unhealthy' },
      }
    }
  }

  const status: SupervisorStatus = 'running'
  return {
    health: { status, checkedAt },
    meta: { ...meta, status },
  }
}

/** Single-shot health check — writes the latest health snapshot to the log. */
export async function runHealthCheck(
  paths: RelayMindPaths,
  opts: { tmuxFn?: TmuxFn; tmuxBin?: string } = {},
): Promise<SupervisorHealth> {
  const tmux = resolveTmux(opts)
  const { health, meta } = await getStatus(paths, { tmuxFn: tmux })
  const sessionName = meta?.sessionName ?? (await loadSessionName(paths))
  const present = meta ? await hasTmuxSession(tmux, sessionName) : false
  await appendLog(
    paths,
    `health status=${health.status} tmux=${present ? 'present' : 'absent'}${health.detail ? ` detail=${health.detail}` : ''}`,
  )
  return health
}

// ─── Logs ───────────────────────────────────────────────────────────────────

export async function tailLogs(
  paths: RelayMindPaths,
  n: number,
): Promise<string[]> {
  if (!Number.isFinite(n) || n <= 0) return []
  let raw: string
  try {
    raw = await readFile(logPath(paths), 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((l) => l.length > 0)
  return lines.slice(-n)
}

/**
 * Capture the last N lines of the live tmux pane. Differs from `tailLogs` —
 * that returns supervisor.log (our own structured events); this returns what
 * Claude is actually rendering on screen, useful when you want to peek
 * without attaching.
 */
export async function capturePane(
  paths: RelayMindPaths,
  n: number,
  opts: { tmuxFn?: TmuxFn; tmuxBin?: string } = {},
): Promise<string[]> {
  if (!Number.isFinite(n) || n <= 0) return []
  const tmux = resolveTmux(opts)
  const sessionName = await loadSessionName(paths)
  if (!(await hasTmuxSession(tmux, sessionName))) return []
  // -p: print to stdout; -S -<n>: start n lines back from the bottom.
  const r = await tmux(['capture-pane', '-t', sessionName, '-p', '-S', `-${n}`])
  if (r.exitCode !== 0) return []
  return r.stdout.split('\n').filter((l) => l.length > 0)
}

// ─── Attach / send-keys ─────────────────────────────────────────────────────

/**
 * Returns the tmux command users should run to attach. The lifecycle handler
 * execs this — we don't attach inside this function because attach replaces
 * the calling process, which is a side effect the supervisor library
 * shouldn't impose on its callers.
 */
export async function attachSession(
  paths: RelayMindPaths,
  opts: { tmuxBin?: string; tmuxFn?: TmuxFn } = {},
): Promise<{ bin: string; args: string[]; sessionName: string; running: boolean }> {
  const tmuxBin = opts.tmuxBin ?? 'tmux'
  const sessionName = await loadSessionName(paths)
  const running = opts.tmuxFn
    ? await hasTmuxSession(opts.tmuxFn, sessionName)
    : await hasTmuxSession(makeTmuxFn(tmuxBin), sessionName)
  return {
    bin: tmuxBin,
    args: ['attach-session', '-t', sessionName],
    sessionName,
    running,
  }
}

/**
 * Send a literal text + Enter into the running tmux pane. Used for self-edit
 * restart flows and programmatic command injection. Refuses when no session
 * is running so callers don't silently lose input.
 *
 * Security: text is passed as a discrete argv entry after `--` to tmux's
 * send-keys, which treats it as a literal keystroke string. No shell.
 */
export async function sendKeys(
  paths: RelayMindPaths,
  text: string,
  opts: { tmuxFn?: TmuxFn; tmuxBin?: string } = {},
): Promise<void> {
  const tmux = resolveTmux(opts)
  const sessionName = await loadSessionName(paths)
  if (!(await hasTmuxSession(tmux, sessionName))) {
    throw new Error(`sendKeys: no tmux session '${sessionName}' running`)
  }
  const r = await tmux(['send-keys', '-t', sessionName, '--', text, 'Enter'])
  if (r.exitCode !== 0) {
    throw new Error(`sendKeys: tmux send-keys failed (exit ${r.exitCode}): ${r.stderr.trim()}`)
  }
  await appendLog(paths, `send-keys name=${sessionName} bytes=${text.length}`)
}

// ─── Registry snapshot / rollback ───────────────────────────────────────────

export async function snapshotRegistry(paths: RelayMindPaths): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(paths.registryJson, 'utf8')
  } catch {
    // Nothing to snapshot — first boot before installer ran.
    return false
  }
  await atomicWrite(paths.lastGoodRegistry, raw)
  await appendLog(paths, 'registry snapshot ok')
  return true
}

/**
 * Restore the last-known-good registry. PRD §867-877: rollback cannot be
 * silently disabled. If no last-good snapshot exists, this MUST throw — the
 * caller decides how to surface the failure.
 */
export async function rollbackRegistry(paths: RelayMindPaths): Promise<void> {
  let raw: string
  try {
    raw = await readFile(paths.lastGoodRegistry, 'utf8')
  } catch {
    throw new Error(
      `supervisor: cannot rollback — no last-good registry at ${paths.lastGoodRegistry}`,
    )
  }
  await atomicWrite(paths.registryJson, raw)
  await appendLog(paths, 'registry rollback ok')
}
