import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdir, readFile as readFileBuffer, unlink, writeFile as writeFileBuffer } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import { displayNameForAccount, isExpiredAccount, loadAuthAccounts, type LocalAuthAccount } from './accounts/auth.js'
import { launchOAuthLogin, saveApiKeyAccount } from './accounts/manage.js'
import { renderDashboard, type DashboardProviderSummary, type DashboardStatusPayload } from './dashboard/render.js'
import { injectGroupModels, shouldInterceptModelsRequest, type ModelEntry } from './proxy/models-interceptor.js'
import { ModelGroupRouter, type ModelGroup } from './proxy/model-group-router.js'
import {
  buildUsagePayload,
  isRequestBodyTooLargeError,
  normalizeAndForward,
  normalizeRequestBody,
  readRequestBody,
  recordUsage,
  recordAccountHit,
  pickNextAccount,
  extractProvider,
  type UsageStats
} from './proxy/forwarding.js'
import { SettingsStore } from './state/settings-store.js'
import { LogBuffer } from './runtime/log-buffer.js'
import { DEFAULT_MODEL_GROUPS, DEFAULT_PROVIDER_ENABLED, REMOVED_PROVIDERS, LOCKED_MODEL_GROUP_NAMES } from './state/defaults.js'
import { pollProviderUsage } from './usage/provider-usage.js'
import { iso8601 } from './runtime/time.js'

export interface ProviderUsageWindow {
  status: string
  primaryUsedPercent?: number
  primaryResetSeconds?: number
  secondaryUsedPercent?: number
  secondaryResetSeconds?: number
  creditBalance?: number
  planType?: string
}

export interface DaemonControllerOptions {
  port?: number
  host?: string
  authDir?: string
  stateDir?: string
  modelGroups?: ModelGroup[]
  upstreamModels?: ModelEntry[]
  upstreamFetch?: typeof fetch
  providerUsageByAccount?: Record<string, Record<string, ProviderUsageWindow>>
  providerEnabled?: Record<string, boolean>
  iconsDir?: string
}

export interface StartedDaemon {
  host: string
  port: number
  pid: number
  childPid: number | null
}

export interface DaemonController {
  start(): Promise<StartedDaemon>
  stop(): Promise<void>
}

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const devRepoRoot = resolve(currentDirectory, '../../..')
// When running as a Bun --compile binary, import.meta.url lives inside the
// virtual /$bunfs/ filesystem (read-only). Resources ship next to the
// executable, so anchor paths on process.execPath instead.
const isCompiled = import.meta.url.startsWith('file:///$bunfs/') || import.meta.url.includes('/$bunfs/root/')
const installRoot = isCompiled ? resolve(dirname(process.execPath), '..') : devRepoRoot
const repoRoot = installRoot
const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
const defaultStateDir = isCompiled
  ? join(homeDir, '.viberelay', 'state')
  : join(devRepoRoot, '.state')
export const bundledBinaryPath = resolve(repoRoot, process.platform === 'win32' ? 'resources/cli-proxy-api.exe' : 'resources/cli-proxy-api')
export const bundledConfigPath = resolve(repoRoot, 'resources/config.yaml')
const defaultAuthDir = join(homeDir, '.cli-proxy-api')
const targetPort = 8328

type RelayChildProcess = ChildProcessByStdio<null, Readable, Readable>

async function assertExecutable(filePath: string) {
  await access(filePath, fsConstants.F_OK | fsConstants.X_OK)
}

async function assertReadable(filePath: string) {
  await access(filePath, fsConstants.F_OK | fsConstants.R_OK)
}

function buildAccountsSummary(accounts: LocalAuthAccount[], settingsState?: SettingsStore['state']): DashboardStatusPayload['accounts'] {
  const visibleAccounts = accounts
    .filter((account) => !settingsState?.removedAccounts.includes(account.fileName))
    .filter((account) => !REMOVED_PROVIDERS.has(account.type))
  const grouped = new Map<string, LocalAuthAccount[]>()

  for (const account of visibleAccounts) {
    const existing = grouped.get(account.type) ?? []
    existing.push(account)
    grouped.set(account.type, existing)
  }

  const providers: Record<string, DashboardProviderSummary> = Object.fromEntries(
    Array.from(grouped.entries()).map(([provider, safeAccounts]) => {
      const activeAccounts = safeAccounts.filter((account) => !isExpiredAccount(account) && settingsState?.accountEnabled[account.fileName] !== false)
      const expiredAccounts = safeAccounts.filter((account) => isExpiredAccount(account) || settingsState?.accountEnabled[account.fileName] === false)

      const summary: DashboardProviderSummary = {
        total: safeAccounts.length,
        active: activeAccounts.length,
        expired: expiredAccounts.length,
        accounts: safeAccounts.map((account) => {
          const entry = {
            display_name: displayNameForAccount(account),
            expired: isExpiredAccount(account),
            enabled: settingsState?.accountEnabled[account.fileName] !== false,
            file: account.fileName,
            ...(account.expired ? { expires_at: iso8601(account.expired) } : {})
          }
          return entry
        })
      }

      return [provider, summary]
    })
  )

  const activeTotal = visibleAccounts.filter((account) => !isExpiredAccount(account) && settingsState?.accountEnabled[account.fileName] !== false).length
  const expiredTotal = visibleAccounts.filter((account) => isExpiredAccount(account) || settingsState?.accountEnabled[account.fileName] === false).length

  return {
    total: visibleAccounts.length,
    active: activeTotal,
    expired: expiredTotal,
    providers
  }
}

function buildModelsCatalog(upstreamModels: ModelEntry[], groupNames: string[], customModels: Array<{ owner: string, id: string }> = []) {
  const merged: ModelEntry[] = [...upstreamModels]
  const seen = new Set(merged.map((entry) => `${entry.owned_by}/${entry.id}`))
  for (const custom of customModels) {
    const key = `${custom.owner}/${custom.id}`
    if (!seen.has(key)) {
      merged.push({ id: custom.id, owned_by: custom.owner })
      seen.add(key)
    }
  }
  const filtered = merged.filter((entry) => !REMOVED_PROVIDERS.has(entry.owned_by))
  const injected = injectGroupModels({ data: filtered }, groupNames)
  const groups: Record<string, Array<{ id: string }>> = {}

  for (const model of injected.data) {
    const owner = model.owned_by
    const existing = groups[owner] ?? []
    existing.push({ id: model.id })
    groups[owner] = existing
  }

  return { groups }
}

function buildExtendedUsagePayload(stats: UsageStats, iso8601Fn: (date: Date) => string, providerUsageByAccount: Record<string, Record<string, ProviderUsageWindow>>, accountLabels: Record<string, Record<string, string>> = {}, activeByType?: Map<string, string[]>) {
  const next_account_by_provider: Record<string, string> = {}
  if (activeByType) {
    for (const [provider, files] of activeByType.entries()) {
      if (files.length === 0) continue
      const idx = (stats.accountRotationIndex[provider] ?? 0) % files.length
      next_account_by_provider[provider] = files[idx]!
    }
  }
  return {
    ...buildUsagePayload(stats, iso8601Fn),
    provider_usage: providerUsageByAccount,
    account_labels: accountLabels,
    next_account_by_provider
  }
}

function buildAccountLabels(accounts: LocalAuthAccount[]): Record<string, Record<string, string>> {
  const labels: Record<string, Record<string, string>> = {}
  for (const account of accounts) {
    const bucket = labels[account.type] ?? (labels[account.type] = {})
    bucket[account.fileName] = displayNameForAccount(account)
  }
  return labels
}

function parseBoolean(value: string | null | undefined) {
  return value === 'true' || value === 'on' || value === '1'
}

function isFresh(timestamp: number, ttlMs: number) {
  return timestamp > 0 && Date.now() - timestamp < ttlMs
}

function parseFormBody(body: string) {
  const params = new URLSearchParams(body)
  return Object.fromEntries(params.entries())
}

function isSafeOrigin(request: import('node:http').IncomingMessage, expectedHost: string, expectedPort: number): boolean {
  const origin = request.headers.origin
  if (!origin || (Array.isArray(origin) && origin.length === 0)) return true
  const value = Array.isArray(origin) ? origin[0] : origin
  if (!value) return true
  const allowed = new Set([
    `http://${expectedHost}:${expectedPort}`,
    `http://127.0.0.1:${expectedPort}`,
    `http://localhost:${expectedPort}`
  ])
  return allowed.has(value)
}

function rejectForbiddenOrigin(response: import('node:http').ServerResponse): void {
  response.writeHead(403, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'origin not allowed' }))
}

async function readMutationBody(request: import('node:http').IncomingMessage) {
  const body = await readRequestBody(request)
  const contentType = request.headers['content-type'] ?? ''

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return parseFormBody(body)
  }

  if (body.length === 0) {
    return {}
  }

  return JSON.parse(body) as Record<string, unknown>
}

function mapProviderToAccountType(modelProvider: string | undefined, rawModel: string): string | undefined {
  const normalized = (modelProvider ?? '').toLowerCase()
  if (normalized === 'openai') return 'codex'
  if (normalized === 'anthropic') return 'claude'
  if (normalized === 'google') return 'gemini'
  if (normalized === 'github-copilot' || normalized === 'copilot') return 'github-copilot'
  if (normalized.length > 0) return normalized
  const lowered = rawModel.toLowerCase()
  if (lowered.startsWith('gpt-')) return 'codex'
  if (lowered.startsWith('claude-')) return 'claude'
  return undefined
}

async function loadVisibleAccounts(authDir: string, settingsState?: SettingsStore['state']) {
  const accounts = await loadAuthAccounts(authDir)
  return accounts.filter((account) => !settingsState?.removedAccounts.includes(account.fileName))
}

async function activeAccountsByType(authDir: string, settingsState?: SettingsStore['state']): Promise<Map<string, string[]>> {
  const accounts = await loadVisibleAccounts(authDir, settingsState)
  const byType = new Map<string, string[]>()
  for (const account of accounts) {
    if (isExpiredAccount(account)) continue
    if (settingsState?.accountEnabled[account.fileName] === false) continue
    const list = byType.get(account.type) ?? []
    list.push(account.fileName)
    byType.set(account.type, list)
  }
  return byType
}

async function buildStatusPayload(started: StartedDaemon, authDir: string, modelGroupRouter: ModelGroupRouter, settingsState?: SettingsStore['state']): Promise<DashboardStatusPayload> {
  const accounts = await loadVisibleAccounts(authDir, settingsState)

  return {
    generated_at: iso8601(new Date()),
    proxy: {
      host: started.host,
      port: started.port,
      target_port: targetPort,
      running: true,
      pid: started.pid
    },
    model_groups: {
      last_hit_by_group_id: modelGroupRouter.lastResolvedModelsByGroupId()
    },
    accounts: buildAccountsSummary(accounts, settingsState)
  }
}

export function createDaemonController(options: DaemonControllerOptions = {}): DaemonController {
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? 0
  const authDir = options.authDir ?? defaultAuthDir
  const stateDir = options.stateDir ?? defaultStateDir
  let upstreamModels: ModelEntry[] = options.upstreamModels ?? []
  let upstreamModelsFetchedAt = options.upstreamModels ? Date.now() : 0
  const upstreamFetch = options.upstreamFetch ?? fetch
  let providerUsageByAccount = options.providerUsageByAccount ?? {}
  let providerUsageFetchedAt = options.providerUsageByAccount ? Date.now() : 0
  const runUsagePoll = async (force = false) => {
    if (options.providerUsageByAccount !== undefined) return
    if (!force && isFresh(providerUsageFetchedAt, 15 * 60 * 1000)) return
    try {
      const next = await pollProviderUsage(authDir, upstreamFetch)
      providerUsageByAccount = next
      providerUsageFetchedAt = Date.now()
    } catch {
      // ignore
    }
  }
  const usageStats: UsageStats = {
    totalRequests: 0,
    endpointCounts: {},
    providerCounts: {},
    modelCounts: {},
    accountCounts: {},
    accountRotationIndex: {}
  }

  let server: Server | null = null
  let child: RelayChildProcess | null = null
  let started: StartedDaemon | null = null
  let settingsStore: SettingsStore | null = null
  let modelGroupRouter = new ModelGroupRouter()
  const logBuffer = new LogBuffer(200)
  const defaultIconsDir = resolve(installRoot, 'resources/icons')
  const iconsDir = options.iconsDir ?? defaultIconsDir

  return {
    async start() {
      if (started) {
        return started
      }

      await mkdir(stateDir, { recursive: true })
      settingsStore = new SettingsStore(stateDir, {
        providerEnabled: options.providerEnabled ?? { ...DEFAULT_PROVIDER_ENABLED },
        accountEnabled: {},
        removedAccounts: [],
        modelGroups: options.modelGroups ?? DEFAULT_MODEL_GROUPS.map((group) => ({ ...group, models: [...group.models] })),
        customModels: []
      })
      await settingsStore.load()

      if (options.modelGroups !== undefined) {
        settingsStore.state.modelGroups = options.modelGroups
      }
      if (options.providerEnabled !== undefined) {
        settingsStore.state.providerEnabled = { ...settingsStore.state.providerEnabled, ...options.providerEnabled }
      }

      await settingsStore.save()

      modelGroupRouter = new ModelGroupRouter()
      modelGroupRouter.updateGroups(settingsStore.state.modelGroups)

      await assertExecutable(bundledBinaryPath)
      await assertReadable(bundledConfigPath)

      const derivedConfigPath = join(stateDir, 'cli-proxy-config.yaml')
      try {
        const rawConfig = await readFileBuffer(bundledConfigPath, 'utf8')
        const remapped = String(rawConfig).replace(/^port:\s*\d+/m, `port: ${targetPort}`)
        await writeFileBuffer(derivedConfigPath, remapped, 'utf8')
      } catch {
        // Fall back to bundled path if write fails
      }

      const configToUse = await access(derivedConfigPath, fsConstants.R_OK).then(() => derivedConfigPath).catch(() => bundledConfigPath)

      const nextChild = spawn(bundledBinaryPath, ['-config', configToUse], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child = nextChild
      nextChild.stdout.on('data', (chunk: Buffer) => logBuffer.ingest('stdout', chunk))
      nextChild.stderr.on('data', (chunk: Buffer) => logBuffer.ingest('stderr', chunk))
      nextChild.stdout.resume()
      nextChild.stderr.resume()

      if (options.providerUsageByAccount === undefined) {
        setTimeout(() => void runUsagePoll(true), 2000)
        setInterval(() => void runUsagePoll(), 15 * 60 * 1000).unref()
      }

      if (options.upstreamModels === undefined) {
        const pollChildCatalog = async (force = false) => {
          if (!force && isFresh(upstreamModelsFetchedAt, 15 * 60 * 1000)) return
          try {
            const response = await upstreamFetch(`http://${host}:${targetPort}/v1/models`)
            if (!response.ok) return
            const payload = await response.json() as { data?: ModelEntry[] }
            if (Array.isArray(payload.data)) {
              upstreamModels = payload.data.filter((entry) => typeof entry.id === 'string')
              upstreamModelsFetchedAt = Date.now()
            }
          } catch {
            // child not ready yet
          }
        }
        setTimeout(() => void pollChildCatalog(true), 1500)
      }

      server = createServer(async (request, response) => {
        const hostHeader = request.headers.host ?? ''
        if (hostHeader.startsWith('localhost:')) {
          response.writeHead(302, { location: `http://${host}:${started?.port ?? requestedPort}${request.url ?? '/'}` })
          response.end()
          return
        }
        const urlBasePort = started?.port ?? requestedPort ?? 0
        const url = new URL(request.url ?? '/', `http://${host}:${urlBasePort}`)

        // Access log: visible in daemon.log via `viberelay logs` AND in the
        // dashboard live-logs pane. Skips dashboard/usage endpoints to stay skimmable.
        if (url.pathname.startsWith('/v1/')) {
          const entry = `${new Date().toISOString()} ${request.method ?? 'GET'} ${url.pathname}\n`
          process.stdout.write(entry)
          logBuffer.ingest('stdout', entry)
        }

        // CSRF defense: mutating relay endpoints must come from same-origin
        // (or no-origin) callers. The daemon binds to loopback, but any page
        // the user has open can cross-origin fetch localhost without this.
        if (request.method === 'POST' && url.pathname.startsWith('/relay/')) {
          const activePort = started?.port ?? urlBasePort
          if (!isSafeOrigin(request, host, activePort)) {
            rejectForbiddenOrigin(response)
            return
          }
        }

        try {

        if (request.method === 'GET' && url.pathname === '/') {
          response.writeHead(302, { location: '/dashboard' })
          response.end()
          return
        }

        if (request.method === 'GET' && url.pathname === '/health') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, service: 'viberelay' }))
          return
        }

        if (request.method === 'GET' && url.pathname === '/status' && started) {
          const status = await buildStatusPayload({ ...started, childPid: child?.pid ?? null }, authDir, modelGroupRouter, settingsStore?.state)
          response.end(JSON.stringify(status))
          return
        }

        if (request.method === 'GET' && url.pathname === '/accounts') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(buildAccountsSummary(await loadVisibleAccounts(authDir, settingsStore?.state), settingsStore?.state)))
          return
        }

        if (request.method === 'GET' && url.pathname === '/usage') {
          const usageAccounts = await loadVisibleAccounts(authDir, settingsStore?.state)
          const activeByType = await activeAccountsByType(authDir, settingsStore?.state)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(buildExtendedUsagePayload(usageStats, iso8601, providerUsageByAccount, buildAccountLabels(usageAccounts), activeByType)))
          return
        }

        if (request.method === 'GET' && url.pathname === '/relay/models-catalog') {
          if (options.upstreamModels === undefined && !isFresh(upstreamModelsFetchedAt, 15 * 60 * 1000)) {
            try {
              const response = await upstreamFetch(`http://${host}:${targetPort}/v1/models`)
              if (response.ok) {
                const payload = await response.json() as { data?: ModelEntry[] }
                if (Array.isArray(payload.data)) {
                  upstreamModels = payload.data.filter((entry) => typeof entry.id === 'string')
                  upstreamModelsFetchedAt = Date.now()
                }
              }
            } catch {
              // ignore catalog refresh failures
            }
          }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(buildModelsCatalog(upstreamModels, modelGroupRouter.activeGroupNames(), settingsStore?.state.customModels ?? [])))
          return
        }

        if (request.method === 'GET' && url.pathname === '/relay/settings-state') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(settingsStore?.state ?? { providerEnabled: {}, accountEnabled: {}, removedAccounts: [], modelGroups: [] }))
          return
        }

        if (request.method === 'GET' && url.pathname === '/relay/logs') {
          const sinceRaw = url.searchParams.get('since')
          const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(logBuffer.recent(Number.isFinite(since) ? since : undefined)))
          return
        }

        if (request.method === 'GET' && url.pathname === '/relay/state' && started) {
          const statusPayload = await buildStatusPayload({ ...started, childPid: child?.pid ?? null }, authDir, modelGroupRouter, settingsStore?.state)
          const stateAccounts = await loadVisibleAccounts(authDir, settingsStore?.state)
          const usagePayload = buildExtendedUsagePayload(usageStats, iso8601, providerUsageByAccount, buildAccountLabels(stateAccounts))
          const modelsCatalog = buildModelsCatalog(upstreamModels, modelGroupRouter.activeGroupNames(), settingsStore?.state.customModels ?? [])
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            status: statusPayload,
            usage: usagePayload,
            groups: modelGroupRouter.activeGroupNames(),
            catalog: modelsCatalog,
            settings: settingsStore?.state ?? { providerEnabled: {}, accountEnabled: {}, removedAccounts: [], modelGroups: [] }
          }))
          return
        }

        if (request.method === 'GET' && url.pathname.startsWith('/dashboard-assets/icon-') && url.pathname.endsWith('.png')) {
          const providerKey = url.pathname.slice('/dashboard-assets/icon-'.length, -'.png'.length)
          if (!/^[a-z0-9\-]+$/.test(providerKey)) {
            response.writeHead(400); response.end(); return
          }
          const iconPath = join(iconsDir, `icon-${providerKey}.png`)
          try {
            const buffer = await readFileBuffer(iconPath)
            response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' })
            response.end(buffer)
          } catch {
            response.writeHead(404); response.end()
          }
          return
        }

        if (request.method === 'POST' && url.pathname.startsWith('/relay/providers/') && url.pathname.endsWith('/toggle')) {
          const provider = url.pathname.split('/')[3]
          const body = await readMutationBody(request)
          await settingsStore?.setProviderEnabled(provider, parseBoolean(String(body.enabled ?? 'false')))
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true }))
          return
        }

        if (request.method === 'POST' && url.pathname === '/relay/accounts/add') {
          const body = await readMutationBody(request)
          const provider = String(body.provider ?? '').trim() as 'claude' | 'codex' | 'github-copilot' | 'opencode' | 'nvidia' | 'ollama' | 'openrouter'
          if (provider === 'claude' || provider === 'codex' || provider === 'github-copilot') {
            const result = await launchOAuthLogin(provider)
            if (result.ok) await runUsagePoll(true)
            response.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' })
            response.end(JSON.stringify(result))
            return
          }
          if (provider === 'opencode' || provider === 'nvidia' || provider === 'ollama' || provider === 'openrouter') {
            const apiKey = String(body.apiKey ?? '').trim()
            if (!apiKey) {
              response.writeHead(400, { 'content-type': 'application/json' })
              response.end(JSON.stringify({ ok: false, message: 'apiKey is required' }))
              return
            }
            const saved = await saveApiKeyAccount(authDir, provider, apiKey)
            await runUsagePoll(true)
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ ok: true, message: `Saved ${saved.fileName}` }))
            return
          }
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, message: 'unsupported provider' }))
          return
        }

        if (request.method === 'POST' && url.pathname === '/relay/accounts/toggle') {
          const body = await readMutationBody(request)
          const accountFile = String(body.accountFile ?? '')
          if (!accountFile) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'accountFile is required' }))
            return
          }
          await settingsStore?.setAccountEnabled(accountFile, parseBoolean(String(body.enabled ?? 'false')))
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true }))
          return
        }

        if (request.method === 'POST' && url.pathname === '/relay/accounts/remove') {
          const body = await readMutationBody(request)
          const accountFile = String(body.accountFile ?? '')
          if (!accountFile) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'accountFile is required' }))
            return
          }
          await settingsStore?.removeAccount(accountFile)
          try {
            await unlink(join(authDir, accountFile))
          } catch {
            // file already gone — proceed
          }
          for (const bucket of Object.values(usageStats.accountCounts)) {
            delete bucket[accountFile]
          }
          for (const bucket of Object.values(providerUsageByAccount)) {
            delete bucket[accountFile]
          }
          if (usageStats.lastAccount === accountFile) {
            usageStats.lastAccount = undefined
          }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true }))
          return
        }

        if (request.method === 'POST' && url.pathname === '/relay/model-groups') {
          const body = await readMutationBody(request)
          let group: ModelGroup
          if ('groupId' in body) {
            group = {
              id: String(body.groupId ?? ''),
              name: String(body.groupName ?? ''),
              models: String(body.groupModels ?? '').split(',').map((model) => model.trim()).filter((model) => model.length > 0),
              enabled: parseBoolean(String(body.enabled ?? 'true'))
            }
          } else {
            group = body as unknown as ModelGroup
          }
          await settingsStore?.upsertModelGroup(group)
          modelGroupRouter.updateGroups(settingsStore?.state.modelGroups ?? [])
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true }))
          return
        }

        if (request.method === 'POST' && url.pathname === '/relay/custom-models') {
          const body = await readMutationBody(request)
          const owner = String(body.owner ?? '').trim()
          const id = String(body.id ?? '').trim()
          if (!owner || !id) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'owner and id are required' }))
            return
          }
          await settingsStore?.addCustomModel({ owner, id })
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true }))
          return
        }

        if (request.method === 'POST' && url.pathname === '/relay/custom-models/delete') {
          const body = await readMutationBody(request)
          await settingsStore?.deleteCustomModel(String(body.owner ?? ''), String(body.id ?? ''))
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true }))
          return
        }

        if (request.method === 'GET' && url.pathname === '/relay/validate-model') {
          const owner = url.searchParams.get('owner')
          const id = url.searchParams.get('id')
          if (!owner || !id) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'owner and id required' }))
            return
          }
          const catalog = buildModelsCatalog(upstreamModels, modelGroupRouter.activeGroupNames(), settingsStore?.state.customModels ?? [])
          const exists = (catalog.groups[owner] ?? []).some((entry) => entry.id === id)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ exists, label: `${owner}/${id}` }))
          return
        }

        if ((request.method === 'DELETE' || request.method === 'POST') && url.pathname.startsWith('/relay/model-groups/')) {
          const id = url.pathname.split('/').pop() ?? ''
          await settingsStore?.deleteModelGroup(id)
          modelGroupRouter.updateGroups(settingsStore?.state.modelGroups ?? [])
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true }))
          return
        }

        if (request.method === 'GET' && url.pathname === '/v1/models') {
          recordUsage(usageStats, 'GET', '/v1/models')
          const baseModels = upstreamModels.length > 0
            ? { data: upstreamModels }
            : { data: modelGroupRouter.activeGroupNames().map((name) => ({ id: name, owned_by: 'viberelay' })) }
          const payload = shouldInterceptModelsRequest('GET', '/v1/models')
            ? injectGroupModels(baseModels, modelGroupRouter.activeGroupNames())
            : baseModels
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(payload))
          return
        }

        if (request.method === 'POST' && url.pathname === '/relay/normalize-request') {
          const body = await readRequestBody(request)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(normalizeRequestBody(body))
          return
        }

        if (request.method === 'POST' && [
          '/v1/messages',
          '/v1/messages/count_tokens',
          '/v1/responses',
          '/v1/chat/completions',
          '/v1/completions',
          '/v1/embeddings'
        ].includes(url.pathname)) {
          const body = await readRequestBody(request)
          try {
            JSON.parse(body)
          } catch {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: { message: 'invalid JSON body', type: 'invalid_request_error', code: 'invalid_json' } }))
            return
          }
          const activeByType = await activeAccountsByType(authDir, settingsStore?.state)
          recordUsage(usageStats, 'POST', url.pathname)
          const forwarded = await normalizeAndForward({
            onResolved: (realModel, groupName) => {
              try {
                usageStats.modelCounts[realModel] = (usageStats.modelCounts[realModel] ?? 0) + 1
                const provider = extractProvider(realModel)
                const accountType = mapProviderToAccountType(provider, realModel)
                usageStats.lastGroup = groupName
                usageStats.lastModel = realModel
                usageStats.lastProvider = accountType ?? provider
                usageStats.lastAt = iso8601(new Date())
                if (!accountType) return
                const files = activeByType.get(accountType) ?? []
                const nextFile = pickNextAccount(usageStats, accountType, files)
                if (nextFile) {
                  recordAccountHit(usageStats, accountType, nextFile)
                  usageStats.lastAccount = nextFile
                }
              } catch { /* best-effort */ }
            },
            upstreamFetch,
            targetHost: host,
            targetPort,
            path: url.pathname,
            method: 'POST',
            headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
            body,
            modelGroupRouter,
            stream: true
          })
          response.writeHead(forwarded.status, { 'content-type': forwarded.headers.get('content-type') ?? 'application/json' })
          if (forwarded.bodyStream) {
            const reader = forwarded.bodyStream.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value) response.write(Buffer.from(value))
              }
            } finally {
              response.end()
            }
          } else {
            response.end(forwarded.text)
          }
          return
        }

        if (request.method === 'GET' && url.pathname === '/relay/resolve-model') {
          const modelName = url.searchParams.get('name')
          if (!modelName) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'name is required' }))
            return
          }

          const resolved = modelGroupRouter.resolveModel(modelName)
          if (!resolved) {
            response.writeHead(404, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'group not found' }))
            return
          }

          recordUsage(usageStats, 'GET', '/relay/resolve-model', resolved.realModel)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(resolved))
          return
        }

        if (request.method === 'GET' && url.pathname === '/dashboard' && started) {
          const status = await buildStatusPayload({ ...started, childPid: child?.pid ?? null }, authDir, modelGroupRouter, settingsStore?.state)
          const dashboardAccounts = await loadVisibleAccounts(authDir, settingsStore?.state)
          const usage = buildExtendedUsagePayload(usageStats, iso8601, providerUsageByAccount, buildAccountLabels(dashboardAccounts))
          const modelsCatalog = buildModelsCatalog(upstreamModels, modelGroupRouter.activeGroupNames(), settingsStore?.state.customModels ?? [])
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0', pragma: 'no-cache' })
          response.end(renderDashboard(status, usage, modelGroupRouter.activeGroupNames(), modelsCatalog, settingsStore?.state))
          return
        }

        if (request.method === 'POST' && url.pathname === '/relay/start') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, state: 'running' }))
          return
        }

        if (request.method === 'POST' && (url.pathname === '/relay/stop' || url.pathname === '/relay/shutdown')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, state: 'stopped', pid: process.pid }))
          // Trigger graceful shutdown after the response flushes. SIGTERM is
          // handled by runner.ts, which calls controller.stop() and reaps the
          // Go child before exiting.
          setTimeout(() => { try { process.kill(process.pid, 'SIGTERM') } catch { /* ignore */ } }, 50)
          return
        }

        // Catch-all for any other /v1/* endpoint Claude Code / SDK clients may
        // hit. Forward to the upstream Go child so we stay transparent, and
        // record the hit so the usage counter reflects real traffic.
        if (url.pathname.startsWith('/v1/')) {
          const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await readRequestBody(request)
          recordUsage(usageStats, request.method ?? 'GET', url.pathname)
          const forwarded = await normalizeAndForward({
            upstreamFetch,
            targetHost: host,
            targetPort,
            path: url.pathname,
            method: request.method ?? 'GET',
            headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
            body,
            stream: true
          })
          response.writeHead(forwarded.status, { 'content-type': forwarded.headers.get('content-type') ?? 'application/json' })
          if (forwarded.bodyStream) {
            const reader = forwarded.bodyStream.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value) response.write(Buffer.from(value))
              }
            } finally {
              response.end()
            }
          } else {
            response.end(forwarded.text)
          }
          return
        }

        response.writeHead(404)
        response.end()
        } catch (error) {
          if (isRequestBodyTooLargeError(error)) {
            if (!response.headersSent) {
              response.writeHead(413, { 'content-type': 'application/json' })
            }
            response.end(JSON.stringify({ error: { message: error.message, type: 'request_too_large', code: 'request_body_too_large' } }))
            return
          }
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json' })
          }
          response.end(JSON.stringify({ error: { message: (error as Error).message ?? 'internal error', type: 'internal_error' } }))
        }
      })

      await new Promise<void>((resolvePromise, rejectPromise) => {
        server?.once('error', rejectPromise)
        server?.listen(requestedPort, host, () => resolvePromise())
      })

      const address = server.address() as AddressInfo
      started = {
        host,
        port: address.port,
        pid: process.pid,
        childPid: nextChild.pid ?? null
      }

      return started
    },

    async stop() {
      const activeServer = server
      const activeChild = child
      server = null
      child = null
      started = null

      if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
        await new Promise<void>((resolvePromise) => {
          let resolved = false
          const finish = () => {
            if (resolved) {
              return
            }
            resolved = true
            resolvePromise()
          }

          activeChild.once('exit', finish)
          activeChild.kill('SIGTERM')
          setTimeout(() => {
            if (activeChild.exitCode === null && activeChild.signalCode === null) {
              activeChild.kill('SIGKILL')
            }
          }, 1000)
          setTimeout(finish, 1500)
        })
      }

      if (!activeServer) {
        return
      }

      await new Promise<void>((resolvePromise, rejectPromise) => {
        activeServer.close((error) => {
          if (error) {
            rejectPromise(error)
            return
          }
          resolvePromise()
        })
      })
    }
  }
}
