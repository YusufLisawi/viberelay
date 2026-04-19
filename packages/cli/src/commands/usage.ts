import { isConnectionRefused } from '../lib/daemon-control.js'

export interface UsageCommandOptions {
  baseUrl: string
  color?: boolean
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

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightCyan: '\x1b[96m'
}

function paint(enabled: boolean) {
  if (enabled) return ANSI
  const noop: Record<keyof typeof ANSI, string> = { ...ANSI }
  for (const key of Object.keys(noop) as Array<keyof typeof ANSI>) noop[key] = ''
  return noop
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

function bar(percentUsed: number, width: number, c: ReturnType<typeof paint>) {
  const pct = Math.max(0, Math.min(100, percentUsed))
  const filled = Math.round((pct / 100) * width)
  const empty = width - filled
  const color = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green
  return `${color}${'█'.repeat(filled)}${c.gray}${'░'.repeat(empty)}${c.reset}`
}

function padEnd(s: string, len: number) {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '')
  if (visible.length >= len) return s
  return s + ' '.repeat(len - visible.length)
}

function renderUsage(usage: UsagePayload, opts: { color: boolean; timestamp?: boolean }): string {
  const c = paint(opts.color)
  const out: string[] = []
  const now = new Date()
  const ts = now.toLocaleTimeString()

  const header = `${c.bold}${c.brightCyan}━━ viberelay usage ━━${c.reset}`
  out.push(opts.timestamp ? `${header}  ${c.dim}${ts}${c.reset}` : header)
  out.push('')
  out.push(`${c.dim}total requests${c.reset}  ${c.bold}${c.brightGreen}${usage.total_requests}${c.reset}`)

  const providerEntries = Object.entries(usage.provider_counts ?? {}).sort((l, r) => r[1] - l[1])
  if (providerEntries.length > 0) {
    const maxCount = Math.max(...providerEntries.map(([, n]) => n), 1)
    const maxNameLen = Math.max(...providerEntries.map(([n]) => n.length))
    out.push('')
    out.push(`${c.bold}by provider${c.reset}`)
    for (const [name, count] of providerEntries) {
      const width = 24
      const filled = Math.round((count / maxCount) * width)
      const b = `${c.cyan}${'█'.repeat(filled)}${c.gray}${'░'.repeat(width - filled)}${c.reset}`
      out.push(`  ${padEnd(name, maxNameLen)}  ${b}  ${c.bold}${count}${c.reset}`)
    }
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
    out.push('')
    out.push(`${c.bold}${c.magenta}▸ ${provider}${c.reset}`)
    for (const file of Array.from(accounts).sort()) {
      const hits = accountCounts[provider]?.[file] ?? 0
      const window = providerUsage[provider]?.[file]
      const label = accountLabel(file, provider, usage.account_labels)
      out.push(`  ${c.bold}${label}${c.reset}  ${c.dim}${hits} req${c.reset}`)
      if (window && typeof window.primaryUsedPercent === 'number') {
        const used = window.primaryUsedPercent
        const left = Math.round(100 - used)
        out.push(`    ${c.dim}5h   ${c.reset}${bar(used, 20, c)}  ${c.bold}${left}%${c.reset} ${c.dim}left · resets ${formatReset(window.primaryResetSeconds)}${c.reset}`)
      }
      if (window && typeof window.secondaryUsedPercent === 'number') {
        const used = window.secondaryUsedPercent
        const left = Math.round(100 - used)
        out.push(`    ${c.dim}week ${c.reset}${bar(used, 20, c)}  ${c.bold}${left}%${c.reset} ${c.dim}left · resets ${formatReset(window.secondaryResetSeconds)}${c.reset}`)
      }
      if (window?.planType) {
        out.push(`    ${c.dim}plan ${window.planType}${window.creditBalance !== undefined ? ` · credit ${window.creditBalance}` : ''}${c.reset}`)
      }
    }
  }

  return out.join('\n')
}

async function fetchUsage(baseUrl: string, signal?: AbortSignal): Promise<UsagePayload> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  const onParentAbort = () => controller.abort()
  signal?.addEventListener('abort', onParentAbort, { once: true })
  try {
    const response = await fetch(`${baseUrl}/usage`, { signal: controller.signal })
    return (await response.json()) as UsagePayload
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
  }
}

export interface UsageRunOptions extends UsageCommandOptions {
  json?: boolean
}

export async function runUsageCommand(options: UsageRunOptions) {
  const color = options.color ?? (process.stdout.isTTY ?? false)
  try {
    const usage = await fetchUsage(options.baseUrl)
    if (options.json) return JSON.stringify(usage)
    return renderUsage(usage, { color, timestamp: false })
  } catch (error) {
    if (isConnectionRefused(error)) {
      if (options.json) return JSON.stringify({ error: 'daemon_not_running' })
      return 'viberelay-daemon not running — start it with: viberelay start'
    }
    throw error
  }
}

export interface UsageWatchOptions {
  baseUrl: string
  intervalMs?: number
  signal?: AbortSignal
}

export async function runUsageWatch(options: UsageWatchOptions): Promise<void> {
  const interval = options.intervalMs ?? 2000
  const color = process.stdout.isTTY ?? false
  const write = (s: string) => process.stdout.write(s)
  const clear = () => write('\x1b[2J\x1b[H')
  const hideCursor = () => write('\x1b[?25l')
  const showCursor = () => write('\x1b[?25h')

  const internalAbort = new AbortController()
  const parentSignal = options.signal
  const onParentAbort = () => internalAbort.abort()
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    internalAbort.abort()
    parentSignal?.removeEventListener('abort', onParentAbort)
    showCursor()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('exit', cleanup)
  }
  const onSignal = () => {
    cleanup()
    process.exit(0)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('exit', () => {
    if (!cleaned) {
      write('\x1b[?25h')
    }
  })

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const id = setTimeout(() => {
      internalAbort.signal.removeEventListener('abort', wake)
      resolve()
    }, ms)
    const wake = () => {
      clearTimeout(id)
      resolve()
    }
    internalAbort.signal.addEventListener('abort', wake, { once: true })
  })

  hideCursor()
  try {
    while (!internalAbort.signal.aborted) {
      let body: string
      try {
        const usage = await fetchUsage(options.baseUrl, internalAbort.signal)
        body = renderUsage(usage, { color, timestamp: true })
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') break
        if (isConnectionRefused(error)) {
          body = 'viberelay-daemon not running — start it with: viberelay start'
        } else {
          body = `error: ${(error as Error).message}`
        }
      }
      if (internalAbort.signal.aborted) break
      clear()
      write(body)
      write(`\n\n\x1b[2m(refreshing every ${Math.round(interval / 1000)}s · Ctrl-C to exit)\x1b[0m\n`)
      await sleep(interval)
    }
  } finally {
    cleanup()
  }
}
