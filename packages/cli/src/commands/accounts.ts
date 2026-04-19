export interface AccountsCommandOptions {
  baseUrl: string
}

interface AccountsPayload {
  total: number
  active: number
  expired: number
  providers: Record<string, { active: number, total: number }>
}

import { isConnectionRefused } from '../lib/daemon-control.js'

export async function runAccountsCommand(options: AccountsCommandOptions) {
  try {
    const response = await fetch(`${options.baseUrl}/accounts`)
    const accounts = (await response.json()) as AccountsPayload
    const providers = Object.entries(accounts.providers)
      .map(([provider, summary]) => `${provider} ${summary.active}/${summary.total} active`)
      .join(', ')

    return providers.length > 0 ? providers : `${accounts.active}/${accounts.total} active`
  } catch (error) {
    if (isConnectionRefused(error)) return 'viberelay-daemon not running — start it with: viberelay start'
    throw error
  }
}
