/**
 * RelayMind CLI bridge — see PRD §220-234.
 *
 * The Telegram plugin is a thin transport. When a slash command arrives we
 * serialize Telegram context to JSON and shell out to:
 *
 *   viberelay telegram command run --json
 *
 * stdin: one line of request JSON.
 * stdout: one line of TelegramCommandReply-shaped JSON.
 * stderr: diagnostics, drained separately.
 *
 * Binary resolution (per PRD §367 — never trust user-supplied paths):
 *   1. process.env.VIBERELAY_BIN (absolute path; verified to exist)
 *   2. dev CLI: `bun packages/cli/src/bin.ts` rooted at VIBEMIND_CLI_ROOT or process.cwd()
 *   3. `viberelay` on PATH (handed to spawn; the OS resolves it)
 *
 * Timeout defaults to 5000 ms, configurable via
 * VIBERELAY_RELAYMIND_CLI_TIMEOUT_MS.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export interface TelegramCliRequest {
  schemaVersion: number
  command: string
  args: string
  chat: { id: string }
  user?: { id?: string; username?: string }
  message?: { id?: string; text?: string; ts?: string }
}

/** Normalized reply consumed by server.ts. Tolerant of both legacy
 *  `{handled, text?, llmPrompt?}` and PRD `{action, text?, prompt?, files?}` shapes. */
export interface TelegramCliReply {
  handled: boolean
  text?: string
  llmPrompt?: string
  files?: string[]
}

export interface BridgeOptions {
  timeoutMs?: number
  /** Inject for tests. */
  spawnImpl?: typeof spawn
  /** Inject for tests. */
  resolveBinary?: () => BinaryTarget
}

export interface BinaryTarget {
  command: string
  args: string[]
  cwd?: string
}

const DEFAULT_TIMEOUT_MS = 5000
const MAX_STREAM_BYTES = 1_000_000 // 1 MB cap on stdout/stderr to avoid runaway children.

export function resolveViberelayBinary(env: NodeJS.ProcessEnv = process.env): BinaryTarget {
  const explicit = env.VIBERELAY_BIN?.trim()
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error(`VIBERELAY_BIN must be an absolute path, got: ${explicit}`)
    }
    if (!existsSync(explicit)) {
      throw new Error(`VIBERELAY_BIN does not exist: ${explicit}`)
    }
    return { command: explicit, args: [] }
  }

  const root = env.VIBEMIND_CLI_ROOT ?? process.cwd()
  const entry = join(root, 'packages', 'cli', 'src', 'bin.ts')
  if (existsSync(entry)) {
    return { command: 'bun', args: [entry], cwd: root }
  }

  const onPath = findOnPath('viberelay', env)
  if (onPath) {
    return { command: onPath, args: [] }
  }

  throw new Error(
    'viberelay binary not found: set VIBERELAY_BIN, set VIBEMIND_CLI_ROOT to the repo root, or install `viberelay` on PATH',
  )
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? env.Path ?? ''
  if (!path) return undefined
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Dispatch a Telegram command via the viberelay CLI. Returns the parsed reply
 * on success. Throws on missing binary, non-zero exit, timeout, or malformed
 * JSON. Callers fall back to in-process dispatch on throw.
 */
export async function dispatchViaCli(
  request: TelegramCliRequest,
  options: BridgeOptions = {},
): Promise<TelegramCliReply> {
  const timeoutMs = options.timeoutMs ?? readTimeoutFromEnv() ?? DEFAULT_TIMEOUT_MS
  const resolver = options.resolveBinary ?? (() => resolveViberelayBinary())
  const target = resolver()
  const spawner = options.spawnImpl ?? spawn

  const args = [...target.args, 'telegram', 'command', 'run', '--json']
  const stdout = await runChild(spawner, target.command, args, target.cwd, JSON.stringify(request), timeoutMs)
  return normalizeReply(parseJsonLine(stdout))
}

function readTimeoutFromEnv(): number | undefined {
  const raw = process.env.VIBERELAY_RELAYMIND_CLI_TIMEOUT_MS
  if (!raw) return undefined
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

function runChild(
  spawner: typeof spawn,
  command: string,
  args: string[],
  cwd: string | undefined,
  stdinPayload: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawner(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false

    const finish = (err: Error | null, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value ?? '')
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`viberelay CLI timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_STREAM_BYTES) {
        child.kill('SIGKILL')
        finish(new Error('viberelay CLI stdout exceeded 1 MB'))
        return
      }
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_STREAM_BYTES) return
      stderr += chunk
    })
    child.on('error', error => finish(error))
    child.on('close', code => {
      if (code === 0) {
        finish(null, stdout.trim())
        return
      }
      const detail = stderr.trim() || `exit code ${code ?? 'unknown'}`
      finish(new Error(`viberelay CLI failed: ${detail}`))
    })

    child.stdin?.on('error', () => {
      // Ignore EPIPE from a child that died before reading stdin; the close
      // handler will surface the real error.
    })
    child.stdin?.end(stdinPayload)
  })
}

function parseJsonLine(raw: string): unknown {
  if (!raw.trim()) {
    throw new Error('viberelay CLI returned empty output')
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`viberelay CLI returned malformed JSON: ${reason}`)
  }
}

function normalizeReply(parsed: unknown): TelegramCliReply {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('viberelay CLI returned non-object JSON')
  }
  const obj = parsed as Record<string, unknown>

  // PRD shape: { action: 'reply'|'forward-to-claude'|'noop', text?, prompt?, files? }
  if (typeof obj.action === 'string') {
    if (obj.action === 'noop') return { handled: false }
    if (obj.action === 'reply') {
      return {
        handled: true,
        text: typeof obj.text === 'string' ? obj.text : undefined,
        files: stringArrayOrUndefined(obj.files),
      }
    }
    if (obj.action === 'forward-to-claude') {
      return {
        handled: true,
        llmPrompt: typeof obj.prompt === 'string' ? obj.prompt : undefined,
      }
    }
    throw new Error(`viberelay CLI returned unknown action: ${obj.action}`)
  }

  // Legacy shape: { handled: boolean, text?, llmPrompt? }
  if (typeof obj.handled === 'boolean') {
    if (!obj.handled) return { handled: false }
    return {
      handled: true,
      text: typeof obj.text === 'string' ? obj.text : undefined,
      llmPrompt: typeof obj.llmPrompt === 'string' ? obj.llmPrompt : undefined,
      files: stringArrayOrUndefined(obj.files),
    }
  }

  throw new Error('viberelay CLI reply missing both `action` and `handled`')
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}
