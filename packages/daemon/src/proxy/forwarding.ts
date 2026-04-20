import { stripThinkingBlocks, processThinkingParameter, processEffortLevel, processReasoningEffort, stripResidualModelSuffixes } from './request-transformer.js'
import { ModelGroupRouter } from './model-group-router.js'

export interface UsageStats {
  totalRequests: number
  endpointCounts: Record<string, number>
  providerCounts: Record<string, number>
  modelCounts: Record<string, number>
  accountCounts: Record<string, Record<string, number>>
  accountRotationIndex: Record<string, number>
  statsDay?: string
  lastGroup?: string
  lastModel?: string
  lastProvider?: string
  lastAccount?: string
  lastAt?: string
}

/** Returns the current local date as YYYY-MM-DD, in the daemon's timezone. */
export function currentStatsDay(clock: () => Date = () => new Date()): string {
  // en-CA gives ISO-style YYYY-MM-DD and respects the system locale's date.
  return clock().toLocaleDateString('en-CA')
}

/**
 * Resets per-day counters when the local date changes. Keeps rotation index
 * and last-hit metadata so the round-robin state survives midnight.
 */
export function ensureCurrentDay(stats: UsageStats, clock: () => Date = () => new Date()): boolean {
  const today = currentStatsDay(clock)
  if (stats.statsDay === today) return false
  stats.statsDay = today
  stats.totalRequests = 0
  stats.endpointCounts = {}
  stats.providerCounts = {}
  stats.modelCounts = {}
  stats.accountCounts = {}
  return true
}

const MAX_ENDPOINT_KEYS = 64
const MAX_PROVIDER_KEYS = 32
const MAX_MODEL_KEYS = 128
const MAX_ACCOUNT_KEYS_PER_PROVIDER = 64

function incrementBoundedCounter(bucket: Record<string, number>, key: string, maxKeys: number) {
  bucket[key] = (bucket[key] ?? 0) + 1
  const keys = Object.keys(bucket)
  if (keys.length <= maxKeys) return
  let lowestKey = key
  let lowestValue = bucket[key]
  for (const candidate of keys) {
    if (bucket[candidate] < lowestValue) {
      lowestKey = candidate
      lowestValue = bucket[candidate]
    }
  }
  if (lowestKey !== key) {
    delete bucket[lowestKey]
  }
}

export function recordUsage(stats: UsageStats, method: string, path: string, model?: string, clock: () => Date = () => new Date()) {
  ensureCurrentDay(stats, clock)
  stats.totalRequests += 1
  incrementBoundedCounter(stats.endpointCounts, `${method} ${path}`, MAX_ENDPOINT_KEYS)
  if (model) {
    incrementBoundedCounter(stats.modelCounts, model, MAX_MODEL_KEYS)
  }
}

export function recordAccountHit(stats: UsageStats, providerType: string, accountFile: string, clock: () => Date = () => new Date()) {
  ensureCurrentDay(stats, clock)
  incrementBoundedCounter(stats.providerCounts, providerType, MAX_PROVIDER_KEYS)
  const bucket = stats.accountCounts[providerType] ?? (stats.accountCounts[providerType] = {})
  incrementBoundedCounter(bucket, accountFile, MAX_ACCOUNT_KEYS_PER_PROVIDER)
}

export function pickNextAccount(stats: UsageStats, providerType: string, activeAccountFiles: string[]): string | undefined {
  if (activeAccountFiles.length === 0) return undefined
  const index = (stats.accountRotationIndex[providerType] ?? 0) % activeAccountFiles.length
  stats.accountRotationIndex[providerType] = (index + 1) % activeAccountFiles.length
  return activeAccountFiles[index]
}

export function buildUsagePayload(stats: UsageStats, iso8601: (date: Date) => string) {
  ensureCurrentDay(stats)
  return {
    started_at: iso8601(new Date()),
    generated_at: iso8601(new Date()),
    stats_day: stats.statsDay,
    total_requests: stats.totalRequests,
    endpoint_counts: { ...stats.endpointCounts },
    provider_counts: { ...stats.providerCounts },
    model_counts: { ...stats.modelCounts },
    account_counts: JSON.parse(JSON.stringify(stats.accountCounts)) as Record<string, Record<string, number>>,
    last_group: stats.lastGroup,
    last_model: stats.lastModel,
    last_provider: stats.lastProvider,
    last_account: stats.lastAccount,
    last_at: stats.lastAt
  }
}

export function isModelNotSupportedError(status: number, body: string) {
  return status === 400 && body.includes('model_not_supported')
}

export function isInvalidThinkingSignatureError(status: number, body: string) {
  return status === 400 && body.includes('signature') && body.includes('thinking')
}

export function providerScopedPath(path: string, provider: string) {
  if (path.startsWith('/api/provider/') || path.startsWith('/provider/')) {
    return path
  }
  const cleanPath = path.startsWith('/api/') ? path.slice(4) : path
  return `/api/provider/${provider}${cleanPath}`
}

export function extractProvider(qualifiedModel: string) {
  const slashIndex = qualifiedModel.indexOf('/')
  return slashIndex === -1 ? undefined : qualifiedModel.slice(0, slashIndex)
}

export function rewriteModelInBody(body: string, newModel: string) {
  const json = JSON.parse(body) as Record<string, unknown>
  const slashIndex = newModel.indexOf('/')
  json.model = slashIndex === -1 ? newModel : newModel.slice(slashIndex + 1)
  return JSON.stringify(json)
}

export function normalizeRequestBody(body: string) {
  return processThinkingParameter(body)?.body
    ?? processEffortLevel(body)
    ?? processReasoningEffort(body)
    ?? stripResidualModelSuffixes(body)?.body
    ?? body
}

export const MAX_BODY_BYTES = 100 * 1024 * 1024
export const UPSTREAM_FETCH_TIMEOUT_MS = 120_000

export class RequestBodyTooLargeError extends Error {
  readonly code = 'REQUEST_BODY_TOO_LARGE' as const
  readonly limit: number
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`)
    this.name = 'RequestBodyTooLargeError'
    this.limit = limit
  }
}

export function isRequestBodyTooLargeError(error: unknown): error is RequestBodyTooLargeError {
  return error instanceof RequestBodyTooLargeError
    || (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'REQUEST_BODY_TOO_LARGE')
}

export async function readRequestBody(request: import('node:http').IncomingMessage, maxBytes: number = MAX_BODY_BYTES) {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > maxBytes) {
        request.destroy()
        throw new RequestBodyTooLargeError(maxBytes)
      }
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error
    throw error
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface ForwardedResponse {
  status: number
  headers: Headers
  text: string
  bodyStream?: ReadableStream<Uint8Array>
}

function isStreamingResponse(headers: Headers): boolean {
  const contentType = headers.get('content-type') ?? ''
  if (contentType.toLowerCase().startsWith('text/event-stream')) return true
  const transferEncoding = headers.get('transfer-encoding') ?? ''
  if (transferEncoding.toLowerCase().includes('chunked')) return true
  return false
}

export async function forwardProxyRequest(options: {
  upstreamFetch: typeof fetch
  host: string
  targetPort: number
  path: string
  method: string
  headers: Record<string, string>
  body: string
  timeoutMs?: number
  stream?: boolean
}): Promise<ForwardedResponse> {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? UPSTREAM_FETCH_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let response: Response
  try {
    response = await options.upstreamFetch(`http://${options.host}:${options.targetPort}${options.path}`, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    })
  } catch (error) {
    clearTimeout(timer)
    if ((error as { name?: string }).name === 'AbortError') {
      const headers = new Headers({ 'content-type': 'application/json' })
      return {
        status: 504,
        headers,
        text: JSON.stringify({ error: { message: `upstream fetch timed out after ${timeoutMs}ms`, type: 'upstream_timeout' } })
      }
    }
    throw error
  }
  clearTimeout(timer)

  if (options.stream && response.body && isStreamingResponse(response.headers)) {
    return { status: response.status, headers: response.headers, text: '', bodyStream: response.body }
  }

  const text = await response.text()
  return { status: response.status, headers: response.headers, text }
}

export async function normalizeAndForward(options: {
  upstreamFetch: typeof fetch
  targetHost: string
  targetPort: number
  path: string
  method: string
  headers: Record<string, string>
  body: string
  modelGroupRouter?: ModelGroupRouter
  onResolved?: (realModel: string, groupName?: string) => void
  stream?: boolean
}): Promise<ForwardedResponse> {
  let normalizedBody = normalizeRequestBody(options.body)
  let targetPath = options.path
  let groupContext: { groupId: string, triedModels: Set<string> } | undefined

  try {
    const json = JSON.parse(normalizedBody) as Record<string, unknown>
    const model = typeof json.model === 'string' ? json.model : undefined
    if (model && options.modelGroupRouter) {
      const resolved = options.modelGroupRouter.resolveModel(model)
      if (resolved) {
        normalizedBody = rewriteModelInBody(normalizedBody, resolved.realModel)
        normalizedBody = normalizeRequestBody(normalizedBody)
        const provider = extractProvider(resolved.realModel)
        targetPath = provider ? providerScopedPath(targetPath, provider) : targetPath
        groupContext = { groupId: resolved.groupId, triedModels: new Set([resolved.realModel]) }
        options.onResolved?.(resolved.realModel, resolved.groupName)
      } else if (model) {
        const provider = extractProvider(model)
        if (provider) {
          targetPath = providerScopedPath(targetPath, provider)
        }
        options.onResolved?.(model)
      }
    }
  } catch {
    // keep original path/body
  }

  const first = await forwardProxyRequest({
    upstreamFetch: options.upstreamFetch,
    host: options.targetHost,
    targetPort: options.targetPort,
    path: targetPath,
    method: options.method,
    headers: options.headers,
    body: normalizedBody,
    stream: options.stream
  })

  if (groupContext && [429, 500, 502, 503].includes(first.status)) {
    const nextModel = options.modelGroupRouter?.failoverModel(groupContext.groupId, groupContext.triedModels)
    if (nextModel) {
      options.onResolved?.(nextModel)
      let failoverBody = rewriteModelInBody(normalizedBody, nextModel)
      failoverBody = normalizeRequestBody(failoverBody)
      const nextProvider = extractProvider(nextModel)
      const failoverPath = nextProvider ? providerScopedPath(options.path, nextProvider) : options.path
      return forwardProxyRequest({
        upstreamFetch: options.upstreamFetch,
        host: options.targetHost,
        targetPort: options.targetPort,
        path: failoverPath,
        method: options.method,
        headers: options.headers,
        body: failoverBody,
        stream: options.stream
      })
    }
  }

  if (isInvalidThinkingSignatureError(first.status, first.text)) {
    const strippedBody = stripThinkingBlocks(normalizedBody) ?? normalizedBody
    return forwardProxyRequest({
      upstreamFetch: options.upstreamFetch,
      host: options.targetHost,
      targetPort: options.targetPort,
      path: targetPath,
      method: options.method,
      headers: options.headers,
      body: strippedBody,
      stream: options.stream
    })
  }

  if (isModelNotSupportedError(first.status, first.text)) {
    return forwardProxyRequest({
      upstreamFetch: options.upstreamFetch,
      host: options.targetHost,
      targetPort: options.targetPort,
      path: targetPath,
      method: options.method,
      headers: options.headers,
      body: normalizedBody,
      stream: options.stream
    })
  }

  return first
}
