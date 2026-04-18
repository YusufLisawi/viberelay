export interface UsageCommandOptions {
  baseUrl: string
}

interface UsageWindow {
  status: string
  primaryUsedPercent?: number
  primaryResetSeconds?: number
  secondaryUsedPercent?: number
  secondaryResetSeconds?: number
  creditBalance?: number
  planType?: string
}

interface UsagePayload {
  total_requests: number
  provider_counts: Record<string, number>
  account_counts?: Record<string, Record<string, number>>
  account_labels?: Record<string, Record<string, string>>
  provider_usage?: Record<string, Record<string, UsageWindow>>
}

function formatReset(seconds?: number) {
  if (seconds === undefined || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
  return `${Math.round(seconds / 86400)}d`
}

function accountLabel(file: string, provider: string, labels?: Record<string, Record<string, string>>) {
  const email = labels?.[provider]?.[file]
  if (email && email.length > 0) return email
  return file.replace(/\.json$/, '')
}

export async function runUsageCommand(options: UsageCommandOptions) {
  const response = await fetch(`${options.baseUrl}/usage`)
  const usage = (await response.json()) as UsagePayload
  const lines: string[] = []
  lines.push(`requests ${usage.total_requests}`)

  const providerEntries = Object.entries(usage.provider_counts ?? {}).sort((l, r) => r[1] - l[1])
  if (providerEntries.length > 0) {
    lines.push('by provider: ' + providerEntries.map(([name, count]) => `${name} ${count}`).join(', '))
  }

  const accountCounts = usage.account_counts ?? {}
  const providerUsage = usage.provider_usage ?? {}
  const allProviders = new Set([...Object.keys(accountCounts), ...Object.keys(providerUsage)])
  for (const provider of Array.from(allProviders).sort()) {
    const accounts = new Set([
      ...Object.keys(accountCounts[provider] ?? {}),
      ...Object.keys(providerUsage[provider] ?? {})
    ])
    if (accounts.size === 0) continue
    lines.push(`[${provider}]`)
    for (const file of Array.from(accounts).sort()) {
      const hits = accountCounts[provider]?.[file] ?? 0
      const window = providerUsage[provider]?.[file]
      const parts: string[] = [`${hits} req`]
      if (window && typeof window.primaryUsedPercent === 'number') {
        const remaining = Math.max(0, Math.min(100, 100 - window.primaryUsedPercent))
        parts.push(`5h ${Math.round(remaining)}% left · resets ${formatReset(window.primaryResetSeconds)}`)
      }
      if (window && typeof window.secondaryUsedPercent === 'number') {
        const remaining = Math.max(0, Math.min(100, 100 - window.secondaryUsedPercent))
        parts.push(`weekly ${Math.round(remaining)}% left · resets ${formatReset(window.secondaryResetSeconds)}`)
      }
      lines.push(`  ${accountLabel(file, provider, usage.account_labels)} — ${parts.join(' · ')}`)
    }
  }

  return lines.join('\n')
}
