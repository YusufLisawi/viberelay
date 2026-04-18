import { stripThinkingBlocks, processThinkingParameter, processEffortLevel, processReasoningEffort, stripResidualModelSuffixes } from './request-transformer.js'
import { ModelGroupRouter } from './model-group-router.js'

export interface UsageStats {
  totalRequests: number
  endpointCounts: Record<string, number>
  providerCounts: Record<string, number>
  modelCounts: Record<string, number>
  accountCounts: Record<string, Record<string, number>>
  accountRotationIndex: Record<string, number>
}

export function recordUsage(stats: UsageStats, method: string, path: string, model?: string) {
  stats.totalRequests += 1
  const key = `${method} ${path}`
  stats.endpointCounts[key] = (stats.endpointCounts[key] ?? 0) + 1
  if (model) {
    stats.modelCounts[model] = (stats.modelCounts[model] ?? 0) + 1
  }
}

export function recordAccountHit(stats: UsageStats, providerType: string, accountFile: string) {
  stats.providerCounts[providerType] = (stats.providerCounts[providerType] ?? 0) + 1
  const bucket = stats.accountCounts[providerType] ?? (stats.accountCounts[providerType] = {})
  bucket[accountFile] = (bucket[accountFile] ?? 0) + 1
}

export function pickNextAccount(stats: UsageStats, providerType: string, activeAccountFiles: string[]): string | undefined {
  if (activeAccountFiles.length === 0) return undefined
  const index = (stats.accountRotationIndex[providerType] ?? 0) % activeAccountFiles.length
  stats.accountRotationIndex[providerType] = (index + 1) % activeAccountFiles.length
  return activeAccountFiles[index]
}

export function buildUsagePayload(stats: UsageStats, iso8601: (date: Date) => string) {
  return {
    started_at: iso8601(new Date()),
    generated_at: iso8601(new Date()),
    total_requests: stats.totalRequests,
    endpoint_counts: { ...stats.endpointCounts },
    provider_counts: { ...stats.providerCounts },
    model_counts: { ...stats.modelCounts },
    account_counts: JSON.parse(JSON.stringify(stats.accountCounts)) as Record<string, Record<string, number>>
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

export async function readRequestBody(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function forwardProxyRequest(options: {
  upstreamFetch: typeof fetch
  host: string
  targetPort: number
  path: string
  method: string
  headers: Record<string, string>
  body: string
}) {
  const response = await options.upstreamFetch(`http://${options.host}:${options.targetPort}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body
  })
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
  onResolved?: (realModel: string) => void
}) {
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
        options.onResolved?.(resolved.realModel)
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
    body: normalizedBody
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
        body: failoverBody
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
      body: strippedBody
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
      body: normalizedBody
    })
  }

  return first
}
