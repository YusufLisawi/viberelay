import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface UsageWindow {
  status: string
  primaryUsedPercent?: number
  primaryResetSeconds?: number
  secondaryUsedPercent?: number
  secondaryResetSeconds?: number
  creditBalance?: number
  planType?: string
}

interface AccountRef {
  type: 'claude' | 'codex'
  fileName: string
  accessToken: string
  accountId?: string
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const USAGE_FETCH_TIMEOUT_MS = 10_000

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function pollProviderUsage(authDir: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, Record<string, UsageWindow>>> {
  const accounts = await loadAccountsWithTokens(authDir)
  const result: Record<string, Record<string, UsageWindow>> = {}
  await Promise.all(accounts.map(async (account) => {
    try {
      const window = account.type === 'claude'
        ? await fetchClaude(account, fetchImpl)
        : await fetchCodex(account, fetchImpl)
      if (!window) return
      result[account.type] = result[account.type] ?? {}
      result[account.type][account.fileName] = window
    } catch {
      // Ignore per-account failures
    }
  }))
  return result
}

async function loadAccountsWithTokens(authDir: string): Promise<AccountRef[]> {
  let names: string[] = []
  try { names = await readdir(authDir) } catch { return [] }
  const accounts: AccountRef[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(authDir, name), 'utf8')
      const json = JSON.parse(raw) as Record<string, unknown>
      const type = typeof json.type === 'string' ? json.type.toLowerCase() : null
      const accessToken = typeof json.access_token === 'string' ? json.access_token : undefined
      if (!accessToken) continue
      if (type === 'claude' || type === 'anthropic') {
        accounts.push({ type: 'claude', fileName: name, accessToken })
      } else if (type === 'codex') {
        const accountId = typeof json.account_id === 'string' ? json.account_id : undefined
        accounts.push({ type: 'codex', fileName: name, accessToken, accountId })
      }
    } catch { /* skip malformed */ }
  }
  return accounts
}

function secondsUntil(iso?: string): number | undefined {
  if (!iso) return undefined
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return undefined
  return Math.max(0, Math.round((parsed - Date.now()) / 1000))
}

async function fetchClaude(account: AccountRef, fetchImpl: typeof fetch): Promise<UsageWindow | undefined> {
  const response = await fetchWithTimeout(fetchImpl, CLAUDE_USAGE_URL, {
    headers: {
      authorization: `Bearer ${account.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20'
    }
  }, USAGE_FETCH_TIMEOUT_MS)
  if (response.status === 401 || response.status === 403) {
    return { status: 'invalid_credentials' }
  }
  if (!response.ok) return { status: `error:http_${response.status}` }
  const data = await response.json() as {
    five_hour?: { utilization?: number, resets_at?: string }
    seven_day?: { utilization?: number, resets_at?: string }
    seven_day_sonnet?: { utilization?: number, resets_at?: string }
    extra_usage?: { is_enabled?: boolean, used_credits?: number, monthly_limit?: number }
  }
  return {
    status: 'loaded',
    primaryUsedPercent: data.five_hour?.utilization,
    primaryResetSeconds: secondsUntil(data.five_hour?.resets_at),
    secondaryUsedPercent: data.seven_day?.utilization,
    secondaryResetSeconds: secondsUntil(data.seven_day?.resets_at),
    creditBalance: data.extra_usage?.used_credits
  }
}

async function fetchCodex(account: AccountRef, fetchImpl: typeof fetch): Promise<UsageWindow | undefined> {
  const headers: Record<string, string> = { authorization: `Bearer ${account.accessToken}` }
  if (account.accountId) headers['chatgpt-account-id'] = account.accountId
  const response = await fetchWithTimeout(fetchImpl, CODEX_USAGE_URL, { headers }, USAGE_FETCH_TIMEOUT_MS)
  if (response.status === 401 || response.status === 403) {
    return { status: 'invalid_credentials' }
  }
  if (!response.ok) return { status: `error:http_${response.status}` }
  const data = await response.json() as {
    rate_limit?: {
      primary_window?: { used_percent?: number, reset_after_seconds?: number }
      secondary_window?: { used_percent?: number, reset_after_seconds?: number }
    }
    rate_limits?: Array<{ window_type?: string, used_percent?: number, reset_after_seconds?: number }>
    credits?: { balance?: number | string }
    plan_type?: string
  }
  let primary: { used_percent?: number, reset_after_seconds?: number } | undefined
  let secondary: { used_percent?: number, reset_after_seconds?: number } | undefined
  if (data.rate_limit) {
    primary = data.rate_limit.primary_window
    secondary = data.rate_limit.secondary_window
  } else if (Array.isArray(data.rate_limits)) {
    primary = data.rate_limits.find((entry) => entry.window_type === 'primary')
    secondary = data.rate_limits.find((entry) => entry.window_type === 'secondary')
  }
  const balanceRaw = data.credits?.balance
  const creditBalance = typeof balanceRaw === 'number' ? balanceRaw
    : typeof balanceRaw === 'string' ? Number(balanceRaw) : undefined
  return {
    status: 'loaded',
    primaryUsedPercent: primary?.used_percent,
    primaryResetSeconds: primary?.reset_after_seconds,
    secondaryUsedPercent: secondary?.used_percent,
    secondaryResetSeconds: secondary?.reset_after_seconds,
    creditBalance: Number.isFinite(creditBalance) ? creditBalance : undefined,
    planType: data.plan_type
  }
}
