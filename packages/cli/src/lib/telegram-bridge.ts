/**
 * Telegram bridge worker.
 *
 * Side-channel for inbound Telegram messages while Anthropic issue #36503
 * (the `tengu_harbor` channel gate) silently drops `notifications/claude/channel`
 * from reaching the conversation. The telegram plugin still runs inside the
 * persistent tmux session and continues to emit those notifications, but it
 * also writes a mirror file at `<telegramStateDir>/messages/<id>.json`.
 *
 * This bridge:
 *   1. Polls `<telegramStateDir>/messages/` for pending mirror files.
 *   2. For each: spawns `viberelay run -d <profile> --print --resume <session>
 *      --append-system-prompt "..." "<content>"` with TELEGRAM_DISABLE_POLL=1
 *      so the print-side plugin instance does not fight the live poller for
 *      the bot token.
 *   3. POSTs Claude's stdout to the Telegram Bot HTTP API as a reply.
 *   4. Moves the file to `messages/processed/` (success) or `messages/failed/`
 *      with a sibling `.err` file (failure).
 *
 * Hard rules: Node stdlib + global `fetch` only, no `any`, NodeNext ESM.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import type { RelayMindPaths } from '@viberelay/shared/relaymind'
import type { SupervisorSessionMeta } from '@viberelay/shared/relaymind'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_PRINT_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 5_000
const STOP_POLL_INTERVAL_MS = 100

// ─── Path helpers ────────────────────────────────────────────────────────────

function bridgePidFile(paths: RelayMindPaths): string {
  return join(paths.supervisorStateDir, 'bridge.pid')
}

function bridgeLogFile(paths: RelayMindPaths): string {
  return join(paths.supervisorStateDir, 'bridge.log')
}

function bridgeStateFile(paths: RelayMindPaths): string {
  return join(paths.supervisorStateDir, 'bridge.state.json')
}

function messagesDir(paths: RelayMindPaths): string {
  return join(paths.telegramStateDir, 'messages')
}

function processedDir(paths: RelayMindPaths): string {
  return join(messagesDir(paths), 'processed')
}

function failedDir(paths: RelayMindPaths): string {
  return join(messagesDir(paths), 'failed')
}

// ─── Atomic + pid utilities (mirrors watchdog.ts) ────────────────────────────

async function appendLog(paths: RelayMindPaths, line: string): Promise<void> {
  await mkdir(paths.supervisorStateDir, { recursive: true })
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  await appendFile(bridgeLogFile(paths), stamped, 'utf8')
}

async function atomicWrite(target: string, data: string): Promise<void> {
  await mkdir(join(target, '..'), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, target)
}

async function readPidFile(file: string): Promise<number | null> {
  try {
    const raw = await readFile(file, 'utf8')
    const n = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

interface BridgeState {
  processedCount: number
  failedCount: number
  lastError: string | null
  lastProcessedAt: string | null
}

async function readState(paths: RelayMindPaths): Promise<BridgeState> {
  try {
    const raw = await readFile(bridgeStateFile(paths), 'utf8')
    return JSON.parse(raw) as BridgeState
  } catch {
    return { processedCount: 0, failedCount: 0, lastError: null, lastProcessedAt: null }
  }
}

async function writeState(paths: RelayMindPaths, state: BridgeState): Promise<void> {
  await atomicWrite(bridgeStateFile(paths), JSON.stringify(state, null, 2))
}

// ─── Mirror-file shape (matches telegram-plugin-cc/server.ts) ────────────────

interface MirrorMessage {
  content: string
  meta: {
    chat_id: string
    message_id?: string
    user: string
    user_id: string
    ts: string
    image_path?: string
    attachment_kind?: string
    attachment_file_id?: string
    attachment_size?: string
    attachment_mime?: string
    attachment_name?: string
  }
}

// ─── DI surface ──────────────────────────────────────────────────────────────

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<SpawnResult>

export type FetchFn = (input: string, init: RequestInit) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

export type NowFn = () => Date

// ─── Default real implementations ────────────────────────────────────────────

const defaultSpawn: SpawnFn = (command, args, opts) =>
  new Promise<SpawnResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    const child: ChildProcess = nodeSpawn(command, [...args], {
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      stderr += `\n[bridge] timeout after ${opts.timeoutMs}ms — sending SIGKILL\n`
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, opts.timeoutMs)
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })

const defaultFetch: FetchFn = async (input, init) => {
  // Node 18+ global fetch. Wrap so the DI surface matches the test stubs.
  const res = await fetch(input, init)
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  }
}

// ─── Bridge options ──────────────────────────────────────────────────────────

export interface BridgeOptions {
  /** Override viberelay binary (default: `viberelay` on PATH or `process.execPath`). */
  viberelayBin?: string
  /** Override the profile name. When unset, read from `config.json`. */
  profileName?: string
  /** Override the bot token. When unset, reads `process.env.TELEGRAM_BOT_TOKEN`. */
  botToken?: string
  /** Override the resume session id. When unset, reads from sessionFile. */
  claudeSessionId?: string
  /** Per-message print timeout, default 60 000 ms. */
  printTimeoutMs?: number
  /** DI for tests. */
  spawnFn?: SpawnFn
  fetchFn?: FetchFn
  nowFn?: NowFn
}

// ─── tickBridge — process exactly one message (used by loop + tests) ─────────

export interface TickBridgeResult {
  status: 'idle' | 'processed' | 'failed' | 'misconfigured'
  file?: string
  reason?: string
}

async function listPendingFiles(paths: RelayMindPaths): Promise<string[]> {
  await mkdir(messagesDir(paths), { recursive: true })
  const entries = await readdir(messagesDir(paths), { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.tmp'))
    .map((e) => e.name)
  // Sort by name — message_id-prefixed names roughly preserve telegram order;
  // the .<ms> suffix breaks ties by arrival.
  files.sort()
  return files
}

async function resolveProfileName(paths: RelayMindPaths, override?: string): Promise<string | null> {
  if (override) return override
  try {
    const raw = await readFile(paths.configJson, 'utf8')
    const cfg = JSON.parse(raw) as { viberelayProfile?: { name?: string } }
    return cfg.viberelayProfile?.name ?? null
  } catch {
    return null
  }
}

async function resolveSessionId(paths: RelayMindPaths, override?: string): Promise<string | null> {
  if (override) return override
  try {
    const raw = await readFile(paths.sessionFile, 'utf8')
    const meta = JSON.parse(raw) as SupervisorSessionMeta
    return meta.claudeSessionId ?? null
  } catch {
    return null
  }
}

function buildPrintArgs(input: {
  profileName: string
  sessionId: string
  appendSystemPrompt: string
  content: string
}): string[] {
  return [
    'run',
    '-d',
    input.profileName,
    '--',
    '--print',
    '--resume',
    input.sessionId,
    '--append-system-prompt',
    input.appendSystemPrompt,
    '--output-format',
    'text',
    input.content,
  ]
}

function buildAppendSystemPrompt(meta: MirrorMessage['meta']): string {
  return `[Telegram message from chat ${meta.chat_id} user ${meta.user}]`
}

/**
 * Process exactly one queued message and return the result.
 * Exposed for tests via `relaymind bridge tick` and also called by the loop.
 */
export async function tickBridge(
  paths: RelayMindPaths,
  opts: BridgeOptions = {},
): Promise<TickBridgeResult> {
  const spawnFn = opts.spawnFn ?? defaultSpawn
  const fetchFn = opts.fetchFn ?? defaultFetch
  const printTimeoutMs = opts.printTimeoutMs ?? DEFAULT_PRINT_TIMEOUT_MS

  const botToken = opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    await appendLog(paths, 'tick misconfigured=no-bot-token')
    return { status: 'misconfigured', reason: 'TELEGRAM_BOT_TOKEN not set; bridge cannot reply' }
  }

  const profileName = await resolveProfileName(paths, opts.profileName)
  if (!profileName) {
    await appendLog(paths, 'tick misconfigured=no-profile')
    return { status: 'misconfigured', reason: 'no viberelay profile configured (config.json viberelayProfile.name)' }
  }

  const sessionId = await resolveSessionId(paths, opts.claudeSessionId)
  if (!sessionId) {
    await appendLog(paths, 'tick misconfigured=no-session-id')
    return { status: 'misconfigured', reason: 'no claudeSessionId in session.json — start the relaymind session first' }
  }

  const files = await listPendingFiles(paths)
  if (files.length === 0) return { status: 'idle' }

  const fname = files[0]!
  const fpath = join(messagesDir(paths), fname)

  let payload: MirrorMessage
  try {
    const raw = await readFile(fpath, 'utf8')
    payload = JSON.parse(raw) as MirrorMessage
  } catch (err) {
    await moveToFailed(paths, fname, `unreadable mirror file: ${(err as Error).message}`)
    return { status: 'failed', file: fname, reason: 'unreadable' }
  }

  const viberelayBin = opts.viberelayBin ?? process.env.VIBERELAY_BIN ?? 'viberelay'
  const args = buildPrintArgs({
    profileName,
    sessionId,
    appendSystemPrompt: buildAppendSystemPrompt(payload.meta),
    content: payload.content,
  })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TELEGRAM_DISABLE_POLL: '1',
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_STATE_DIR: paths.telegramStateDir,
  }

  await appendLog(paths, `tick processing file=${fname} chat=${payload.meta.chat_id} msg=${payload.meta.message_id ?? 'none'}`)
  const result = await spawnFn(viberelayBin, args, { env, timeoutMs: printTimeoutMs })

  if (result.code !== 0) {
    const reason = `claude --print exited code=${result.code} stderr=${result.stderr.slice(0, 2000)}`
    await moveToFailed(paths, fname, reason)
    await bumpFailed(paths, reason)
    return { status: 'failed', file: fname, reason }
  }

  const replyText = result.stdout.trim()
  if (replyText.length === 0) {
    const reason = 'claude --print returned empty stdout'
    await moveToFailed(paths, fname, reason)
    await bumpFailed(paths, reason)
    return { status: 'failed', file: fname, reason }
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  const body: Record<string, string | number> = {
    chat_id: payload.meta.chat_id,
    text: replyText,
  }
  if (payload.meta.message_id) {
    const n = Number.parseInt(payload.meta.message_id, 10)
    if (Number.isFinite(n)) body.reply_to_message_id = n
  }

  let httpRes: { ok: boolean; status: number; text: () => Promise<string> }
  try {
    httpRes = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    const reason = `sendMessage transport error: ${(err as Error).message}`
    await moveToFailed(paths, fname, reason)
    await bumpFailed(paths, reason)
    return { status: 'failed', file: fname, reason }
  }

  if (!httpRes.ok) {
    const respBody = await httpRes.text().catch(() => '')
    const reason = `sendMessage http=${httpRes.status} body=${respBody.slice(0, 500)}`
    await moveToFailed(paths, fname, reason)
    await bumpFailed(paths, reason)
    return { status: 'failed', file: fname, reason }
  }

  await moveToProcessed(paths, fname)
  await bumpProcessed(paths, opts.nowFn)
  await appendLog(paths, `tick ok file=${fname}`)
  return { status: 'processed', file: fname }
}

async function moveToProcessed(paths: RelayMindPaths, fname: string): Promise<void> {
  await mkdir(processedDir(paths), { recursive: true })
  await rename(join(messagesDir(paths), fname), join(processedDir(paths), fname))
}

async function moveToFailed(paths: RelayMindPaths, fname: string, reason: string): Promise<void> {
  await mkdir(failedDir(paths), { recursive: true })
  const dst = join(failedDir(paths), fname)
  await rename(join(messagesDir(paths), fname), dst).catch(() => { /* already moved */ })
  await writeFile(`${dst}.err`, `[${new Date().toISOString()}] ${reason}\n`, 'utf8').catch(() => {})
}

async function bumpProcessed(paths: RelayMindPaths, nowFn?: NowFn): Promise<void> {
  const state = await readState(paths)
  state.processedCount += 1
  state.lastProcessedAt = (nowFn ? nowFn() : new Date()).toISOString()
  await writeState(paths, state)
}

async function bumpFailed(paths: RelayMindPaths, reason: string): Promise<void> {
  const state = await readState(paths)
  state.failedCount += 1
  state.lastError = reason
  await writeState(paths, state)
}

// ─── Loop ────────────────────────────────────────────────────────────────────

export interface BridgeLoopOptions extends BridgeOptions {
  pollIntervalMs?: number
  signal?: AbortSignal
}

export async function runBridgeLoop(
  paths: RelayMindPaths,
  opts: BridgeLoopOptions = {},
): Promise<void> {
  const intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const signal = opts.signal

  await appendLog(paths, `bridge started pid=${process.pid} interval=${intervalMs}ms`)
  // Concurrency note: a `claude --print --resume <id>` invocation against a
  // session id that is currently OPEN in tmux may conflict with the live
  // session — Claude Code does not document concurrent --resume behaviour.
  // If you observe interference, either detach from tmux while the bridge
  // runs or point the bridge at a side session id (see RELAYMIND.md).
  await appendLog(paths, 'bridge note: --print --resume runs concurrently with the live tmux session; if you see interference, detach from tmux or use a side session id.')

  while (!signal?.aborted) {
    try {
      let res = await tickBridge(paths, opts)
      // Drain the queue greedily so a burst of messages doesn't wait an
      // entire poll-interval per file.
      while (res.status === 'processed' && !signal?.aborted) {
        res = await tickBridge(paths, opts)
      }
    } catch (err) {
      await appendLog(paths, `tick-error ${(err as Error).message}`)
    }

    if (signal?.aborted) break

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs)
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t)
          resolve()
        }, { once: true })
      }
    })
  }

  await appendLog(paths, `bridge stopped pid=${process.pid}`)
}

// ─── start / stop / status ───────────────────────────────────────────────────

export interface StartBridgeOptions extends BridgeLoopOptions {
  foreground?: boolean
}

export async function startBridge(
  paths: RelayMindPaths,
  opts: StartBridgeOptions = {},
): Promise<void> {
  await mkdir(paths.supervisorStateDir, { recursive: true })

  if (opts.foreground) {
    await atomicWrite(bridgePidFile(paths), `${process.pid}\n`)
    await appendLog(paths, `bridge foreground started pid=${process.pid}`)

    const ac = new AbortController()
    const signal = opts.signal ?? ac.signal
    const cleanup = async () => {
      ac.abort()
      await rm(bridgePidFile(paths), { force: true })
    }
    process.once('SIGINT', () => { void cleanup() })
    process.once('SIGTERM', () => { void cleanup() })

    try {
      await runBridgeLoop(paths, { ...opts, signal })
    } finally {
      await rm(bridgePidFile(paths), { force: true })
    }
    return
  }

  const { spawn } = await import('node:child_process')
  const entry = process.argv[1] ?? 'viberelay'
  const args: string[] = [entry, 'relaymind', 'bridge', 'start', '--foreground']
  if (opts.pollIntervalMs !== undefined) {
    args.push('--interval', String(opts.pollIntervalMs))
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  if (typeof child.pid !== 'number') {
    throw new Error('bridge: failed to spawn background process (no pid)')
  }
  child.unref()
  await atomicWrite(bridgePidFile(paths), `${child.pid}\n`)
  await appendLog(paths, `bridge background started pid=${child.pid}`)
}

export async function stopBridge(paths: RelayMindPaths): Promise<{ stopped: boolean; pid: number | null }> {
  const pid = await readPidFile(bridgePidFile(paths))
  if (pid === null) {
    await appendLog(paths, 'bridge stop noop=no-pid')
    return { stopped: false, pid: null }
  }
  if (!isAlive(pid)) {
    await rm(bridgePidFile(paths), { force: true })
    await appendLog(paths, `bridge stop noop=stale-pid pid=${pid}`)
    return { stopped: false, pid }
  }
  try { process.kill(pid, 'SIGTERM') } catch (err) {
    await appendLog(paths, `bridge stop sigterm-failed pid=${pid} err=${(err as Error).message}`)
  }
  const deadline = Date.now() + STOP_GRACE_MS
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break
    await new Promise((r) => setTimeout(r, STOP_POLL_INTERVAL_MS))
  }
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    await appendLog(paths, `bridge stop sigkill pid=${pid}`)
  } else {
    await appendLog(paths, `bridge stop sigterm-ok pid=${pid}`)
  }
  await rm(bridgePidFile(paths), { force: true })
  return { stopped: true, pid }
}

export interface BridgeStatus {
  running: boolean
  pid: number | null
  processedCount: number
  failedCount: number
  lastError: string | null
  lastProcessedAt: string | null
  pendingCount: number
  nextPendingFile: string | null
}

export async function getBridgeStatus(paths: RelayMindPaths): Promise<BridgeStatus> {
  const pid = await readPidFile(bridgePidFile(paths))
  const running = pid !== null && isAlive(pid)
  const state = await readState(paths)
  const pending = await listPendingFiles(paths).catch(() => [] as string[])

  return {
    running,
    pid: running ? pid : null,
    processedCount: state.processedCount,
    failedCount: state.failedCount,
    lastError: state.lastError,
    lastProcessedAt: state.lastProcessedAt,
    pendingCount: pending.length,
    nextPendingFile: pending[0] ?? null,
  }
}
