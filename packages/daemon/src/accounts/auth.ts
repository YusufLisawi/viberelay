import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface LocalAuthAccount {
  id: string
  fileName: string
  type: string
  email?: string
  login?: string
  accountId?: string
  planType?: string
  workspaceTitle?: string
  lastRefresh?: Date
  expired?: Date
}

function parseDate(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function extractCodexMeta(json: Record<string, unknown>) {
  const payload = decodeJwtPayload(json.id_token)
  const auth = payload?.['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object') return {}
  const authObj = auth as Record<string, unknown>
  const planType = typeof authObj.chatgpt_plan_type === 'string' ? authObj.chatgpt_plan_type : undefined
  const orgs = Array.isArray(authObj.organizations) ? authObj.organizations as Array<Record<string, unknown>> : undefined
  const defaultOrg = orgs?.find((org) => org.is_default === true) ?? orgs?.[0]
  const workspaceTitle = defaultOrg && typeof defaultOrg.title === 'string' ? defaultOrg.title : undefined
  return { planType, workspaceTitle }
}

export function isExpiredAccount(account: LocalAuthAccount) {
  return account.expired !== undefined && account.expired.getTime() < Date.now()
}

export function displayNameForAccount(account: LocalAuthAccount, override?: string) {
  if (override && override.length > 0) {
    return override
  }

  const base = account.email && account.email.length > 0
    ? account.email
    : account.login && account.login.length > 0
      ? account.login
      : account.id

  const suffix: string[] = []
  if (account.workspaceTitle && account.workspaceTitle !== 'Personal') {
    suffix.push(account.workspaceTitle)
  } else if (account.planType) {
    suffix.push(account.planType)
  }
  if (account.accountId) {
    suffix.push(`#${account.accountId.slice(0, 6)}`)
  }

  return suffix.length > 0 ? `${base} · ${suffix.join(' · ')}` : base
}

function dedupeAccounts(accounts: LocalAuthAccount[]): LocalAuthAccount[] {
  const byKey = new Map<string, LocalAuthAccount>()
  const passthrough: LocalAuthAccount[] = []

  for (const account of accounts) {
    if (!account.accountId) {
      passthrough.push(account)
      continue
    }
    const key = `${account.type}:${account.accountId}:${account.email ?? ''}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, account)
      continue
    }
    const winner = (account.lastRefresh?.getTime() ?? 0) > (existing.lastRefresh?.getTime() ?? 0) ? account : existing
    byKey.set(key, winner)
  }

  return [...passthrough, ...byKey.values()]
}

export async function loadAuthAccounts(authDir: string): Promise<LocalAuthAccount[]> {
  let files: string[] = []

  try {
    files = await readdir(authDir)
  } catch {
    return []
  }

  const accounts = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (fileName): Promise<LocalAuthAccount | null> => {
    try {
      const raw = await readFile(join(authDir, fileName), 'utf8')
      const json = JSON.parse(raw) as Record<string, unknown>
      const type = typeof json.type === 'string' ? json.type.toLowerCase() : null
      if (!type) {
        return null
      }

      const codexMeta = type === 'codex' ? extractCodexMeta(json) : {}

      return {
        id: fileName,
        fileName,
        type,
        email: typeof json.email === 'string' ? json.email : undefined,
        login: typeof json.login === 'string'
          ? json.login
          : typeof json.username === 'string'
            ? json.username
            : typeof json.name === 'string'
              ? json.name
              : undefined,
        accountId: typeof json.account_id === 'string' ? json.account_id : undefined,
        planType: codexMeta.planType,
        workspaceTitle: codexMeta.workspaceTitle,
        lastRefresh: parseDate(json.last_refresh),
        expired: parseDate(json.expired)
      }
    } catch {
      return null
    }
  }))

  const loaded = accounts.filter((account): account is LocalAuthAccount => account !== null)
  return dedupeAccounts(loaded).sort((left, right) => left.type.localeCompare(right.type))
}
