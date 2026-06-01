import { spawn } from 'node:child_process'

export interface CursorRunResult {
  code: number
  stdout: string
  stderr: string
}

export type CursorRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<CursorRunResult>

export interface CursorUpstreamResponse {
  status: number
  headers: Headers
  text: string
  bodyStream?: ReadableStream<Uint8Array>
}

interface CursorPrompt {
  model: string
  prompt: string
}

const DEFAULT_CURSOR_BIN = 'cursor-agent'
const DEFAULT_CURSOR_TIMEOUT_MS = 120_000
const CURSOR_PROVIDER_PREFIX = 'cursor/'

export function isCursorModel(model: string | undefined): model is string {
  return typeof model === 'string' && model.startsWith(CURSOR_PROVIDER_PREFIX) && model.length > CURSOR_PROVIDER_PREFIX.length
}

export function addCursorModels(models: Array<{ id: string, owned_by: string }>) {
  const hasCursor = models.some((model) => model.owned_by === 'cursor')
  if (hasCursor) return models
  return [
    ...models,
    { id: 'cursor/claude-opus-4-7-high', owned_by: 'cursor' },
    { id: 'cursor/claude-opus-4-7-thinking-high', owned_by: 'cursor' },
    { id: 'cursor/composer-2.5', owned_by: 'cursor' },
    { id: 'cursor/gpt-5.5-high', owned_by: 'cursor' },
    { id: 'cursor/gpt-5.4-high', owned_by: 'cursor' }
  ]
}

export async function maybeHandleCursorUpstream(options: {
  path: string
  body: string
  runner?: CursorRunner
  now?: () => number
}): Promise<CursorUpstreamResponse | undefined> {
  const prompt = buildCursorPrompt(options.path, options.body)
  if (!prompt) return undefined

  const run = options.runner ?? defaultCursorRunner
  const result = await run([
    '--print',
    '--trust',
    '--mode',
    'ask',
    '--model',
    prompt.model,
    prompt.prompt
  ], process.env)

  if (result.code !== 0) {
    return jsonResponse(502, { error: { message: result.stderr.trim() || `cursor-agent exited with code ${result.code}`, type: 'cursor_upstream_error' } })
  }

  const text = result.stdout.trimEnd()
  if (options.path === '/v1/chat/completions') {
    return jsonResponse(200, toOpenAIChatCompletion(prompt.model, text, options.now?.() ?? Date.now()))
  }
  if (options.path === '/v1/messages') {
    return jsonResponse(200, toAnthropicMessage(prompt.model, text))
  }
  if (options.path === '/v1/responses') {
    return jsonResponse(200, toOpenAIResponse(prompt.model, text, options.now?.() ?? Date.now()))
  }

  return undefined
}

function buildCursorPrompt(path: string, body: string): CursorPrompt | undefined {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(body) as Record<string, unknown>
  } catch {
    return undefined
  }

  const requestedModel = typeof json.model === 'string' ? json.model : undefined
  if (!isCursorModel(requestedModel)) return undefined
  const model = requestedModel.slice(CURSOR_PROVIDER_PREFIX.length)

  if (path === '/v1/chat/completions' || path === '/v1/messages') {
    const messages = Array.isArray(json.messages) ? json.messages : []
    return { model, prompt: messagesToPrompt(messages) }
  }

  if (path === '/v1/responses') {
    return { model, prompt: responseInputToPrompt(json.input) }
  }

  return undefined
}

function messagesToPrompt(messages: unknown[]): string {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return ''
    const record = message as Record<string, unknown>
    const role = typeof record.role === 'string' ? record.role : 'user'
    return `${role}: ${contentToText(record.content)}`
  }).filter(Boolean).join('\n\n')
}

function responseInputToPrompt(input: unknown): string {
  if (typeof input === 'string') return input
  if (Array.isArray(input)) return input.map((entry) => {
    if (!entry || typeof entry !== 'object') return contentToText(entry)
    const record = entry as Record<string, unknown>
    const role = typeof record.role === 'string' ? record.role : 'user'
    return `${role}: ${contentToText(record.content)}`
  }).filter(Boolean).join('\n\n')
  return contentToText(input)
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      if (typeof record.content === 'string') return record.content
      return ''
    }).filter(Boolean).join('\n')
  }
  return ''
}

function toOpenAIChatCompletion(model: string, text: string, nowMs: number) {
  return {
    id: `chatcmpl-cursor-${nowMs}`,
    object: 'chat.completion',
    created: Math.floor(nowMs / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
  }
}

function toAnthropicMessage(model: string, text: string) {
  return {
    id: `msg_cursor_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 }
  }
}

function toOpenAIResponse(model: string, text: string, nowMs: number) {
  return {
    id: `resp_cursor_${nowMs}`,
    object: 'response',
    created_at: Math.floor(nowMs / 1000),
    status: 'completed',
    model,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
  }
}

function jsonResponse(status: number, payload: unknown): CursorUpstreamResponse {
  return { status, headers: new Headers({ 'content-type': 'application/json' }), text: JSON.stringify(payload) }
}

function defaultCursorRunner(args: string[], env: NodeJS.ProcessEnv): Promise<CursorRunResult> {
  const bin = process.env.VIBERELAY_CURSOR_BIN ?? DEFAULT_CURSOR_BIN
  const timeoutMs = Number.parseInt(process.env.VIBERELAY_CURSOR_TIMEOUT_MS ?? String(DEFAULT_CURSOR_TIMEOUT_MS), 10)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const childEnv = { ...env, PATH: [env.PATH, `${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':') }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolvePromise({ code: 124, stdout: Buffer.concat(stdout).toString('utf8'), stderr: `cursor-agent timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 0, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}
