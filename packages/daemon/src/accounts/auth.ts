import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface LocalAuthAccount {
  id: string
  fileName: string
  type: string
  email?: string
  login?: string
  expired?: Date
}

function parseDate(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export function isExpiredAccount(account: LocalAuthAccount) {
  return account.expired !== undefined && account.expired.getTime() < Date.now()
}

export function displayNameForAccount(account: LocalAuthAccount) {
  if (account.email && account.email.length > 0) {
    return account.email
  }

  if (account.login && account.login.length > 0) {
    return account.login
  }

  return account.id
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

      return {
        id: fileName,
        fileName,
        type,
        email: typeof json.email === 'string' ? json.email : undefined,
        login: typeof json.login === 'string' ? json.login : undefined,
        expired: parseDate(json.expired)
      }
    } catch {
      return null
    }
  }))

  return accounts.filter((account): account is LocalAuthAccount => account !== null).sort((left, right) => left.type.localeCompare(right.type))
}
