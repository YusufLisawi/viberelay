export interface DashboardAccountEntry {
  display_name: string
  expired: boolean
  file: string
  expires_at?: string
}

export interface DashboardProviderSummary {
  total: number
  active: number
  expired: number
  accounts: DashboardAccountEntry[]
}

export interface DashboardStatusPayload {
  generated_at: string
  proxy: {
    host: string
    port: number
    target_port: number
    running: boolean
  }
  model_groups: {
    last_hit_by_group_id: Record<string, string>
  }
  accounts: {
    total: number
    active: number
    expired: number
    providers: Record<string, DashboardProviderSummary>
  }
}

export interface DashboardUsageWindow {
  status: string
  primaryUsedPercent?: number
  primaryResetSeconds?: number
  secondaryUsedPercent?: number
  secondaryResetSeconds?: number
  creditBalance?: number
  planType?: string
}

export interface DashboardUsagePayload {
  started_at: string
  generated_at: string
  total_requests: number
  endpoint_counts: Record<string, number>
  provider_counts: Record<string, number>
  model_counts: Record<string, number>
  account_counts?: Record<string, Record<string, number>>
  account_labels?: Record<string, Record<string, string>>
  provider_usage?: Record<string, Record<string, DashboardUsageWindow>>
}

export interface DashboardModelsCatalog {
  groups: Record<string, Array<{ id: string }>>
}

export interface DashboardSettingsPayload {
  providerEnabled: Record<string, boolean>
  accountEnabled: Record<string, boolean>
  removedAccounts: string[]
  modelGroups: Array<{ id: string, name: string, models: string[], enabled: boolean }>
  customModels?: Array<{ owner: string, id: string }>
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function formatReset(seconds?: number) {
  if (seconds === undefined || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

function bar(label: string, percent?: number, resetSeconds?: number) {
  const value = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : undefined
  const tone = value === undefined ? 'muted' : value >= 90 ? 'danger' : value >= 70 ? 'warn' : 'ok'
  const shown = value === undefined ? '—' : `${value.toFixed(0)}% used`
  return `<div class="bar-row">
    <div class="bar-label"><span>${escape(label)}</span><span class="bar-value">${shown} <span class="bar-reset">· resets ${formatReset(resetSeconds)}</span></span></div>
    <div class="bar"><div class="bar-fill ${tone}" style="width:${value ?? 0}%"></div></div>
  </div>`
}

const PROVIDER_ICONS: Record<string, string> = {
  claude: 'claude', anthropic: 'claude',
  codex: 'codex', openai: 'codex',
  gemini: 'gemini', google: 'gemini',
  'github-copilot': 'copilot', copilot: 'copilot',
  cursor: 'cursor',
  antigravity: 'antigravity',
  qwen: 'qwen',
  zai: 'zai'
}

function providerIcon(name: string) {
  const slug = PROVIDER_ICONS[name.toLowerCase()]
  if (!slug) return `<span class="provider-icon provider-icon-fallback">${escape(name.charAt(0).toUpperCase())}</span>`
  return `<img class="provider-icon" src="/dashboard-assets/icon-${slug}.png" alt="${escape(name)}" />`
}

export function renderDashboard(
  status: DashboardStatusPayload,
  usage: DashboardUsagePayload,
  groups: string[],
  modelsCatalog?: DashboardModelsCatalog,
  settings?: DashboardSettingsPayload
) {
  const body = renderBody(status, usage, groups, modelsCatalog, settings)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VibeRelay Dashboard</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <div id="app-body">${body}</div>
    <div class="toast" id="toast"></div>
    <script>${SCRIPT}</script>
  </body>
</html>`
}

function renderBody(
  status: DashboardStatusPayload,
  usage: DashboardUsagePayload,
  groups: string[],
  modelsCatalog?: DashboardModelsCatalog,
  settings?: DashboardSettingsPayload
): string {
  const providerEntries = Object.entries(status.accounts.providers)
  const endpointEntries = Object.entries(usage.endpoint_counts).sort((l, r) => r[1] - l[1]).slice(0, 6)
  const modelEntries = Object.entries(usage.model_counts).sort((l, r) => r[1] - l[1]).slice(0, 6)
  const providerCountEntries = Object.entries(usage.provider_counts ?? {}).sort((l, r) => r[1] - l[1])
  const providerUsage = usage.provider_usage ?? {}
  const catalogEntries = Object.entries(modelsCatalog?.groups ?? {})
  const providerNames = Array.from(new Set([
    ...Object.keys(status.accounts.providers),
    ...Object.keys(settings?.providerEnabled ?? {})
  ])).sort()
  const orderedUsageProviders = ['codex', 'claude'].filter((provider) => provider in providerUsage)
    .concat(Object.keys(providerUsage).filter((provider) => !['codex', 'claude'].includes(provider)).sort())
  const modelGroupEntries = settings?.modelGroups ?? []
  const allCatalogModels = catalogEntries.flatMap(([owner, models]) => models.map((model) => ({ owner, id: model.id })))
  const catalogJson = JSON.stringify(allCatalogModels)
  const groupsPresent = groups.includes.bind(groups)

  return `
    <div class="shell">
      <div class="topbar">
        <div class="topbar-left">
          <div>
            <h1 class="wordmark">VIBERELAY</h1>
            <div class="sub mono">${escape(status.proxy.host)}:${status.proxy.port} → :${status.proxy.target_port}</div>
          </div>
        </div>
        <div class="topbar-right">
          <div class="status-badge ${status.proxy.running ? 'running' : 'stopped'}">${status.proxy.running ? 'Running' : 'Stopped'}</div>
          ${status.proxy.running
            ? '<button class="btn ghost" data-act="relay-stop" data-action="stop">Stop</button>'
            : '<button class="btn primary" data-act="relay-start" data-action="start">Start</button>'}
        </div>
      </div>

      <section aria-label="Summary" data-status="${status.proxy.running ? 'Server running' : 'Server stopped'}">
        <div class="metrics">
          <div class="metric"><div class="k">Summary · Requests</div><div class="v">${usage.total_requests}</div></div>
          <div class="metric"><div class="k">Active accounts</div><div class="v">${status.accounts.active}<span class="muted" style="font-size:13px;">/${status.accounts.total}</span></div></div>
          <div class="metric"><div class="k">Expired</div><div class="v">${status.accounts.expired}</div></div>
          <div class="metric"><div class="k">Groups</div><div class="v">${groups.length}</div></div>
          <div class="metric"><div class="k">Bind</div><div class="v mono small">${escape(status.proxy.host)}:${status.proxy.port}</div></div>
        </div>
      </section>

      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="accounts">Accounts</button>
        <button class="tab" data-tab="groups">Model Groups</button>
        <button class="tab" data-tab="usage">Usage</button>
        <button class="tab" data-tab="providers">Providers</button>
        <button class="tab" data-tab="logs">Logs</button>
        <button class="tab" data-tab="utility">Utility</button>
      </div>

      <div id="tab-accounts" class="tab-panel active">
        <div class="card">
          <div class="card-head">
            <h2>Account Actions</h2>
            <div class="actions">
              <span class="sub">${status.accounts.active} active · ${status.accounts.expired} expired</span>
              <button type="button" class="icon-btn" data-open-modal="account-settings-modal" title="Account settings" aria-label="Account settings">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 9 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
            </div>
          </div>
          <div class="card-body">
            <div class="quick-add-row">
              ${['claude', 'codex', 'github-copilot', 'opencode', 'nvidia', 'ollama', 'openrouter'].map((provider) => `<button type="button" class="btn" data-open-modal="add-account-modal" data-provider="${provider}">+ ${provider}</button>`).join('')}
            </div>
            ${providerEntries.length === 0 ? `<p class="empty">No accounts. Use + buttons above or run <span class="kbd">cli-proxy-api-plus -claude-login</span> / <span class="kbd">-codex-login</span>.</p>` : providerEntries.map(([provider, summary]) => {
              const providerRequests = usage.provider_counts?.[provider] ?? 0
              return `<div class="provider-group">
                <div class="provider-head">
                  <div class="provider-title">${providerIcon(provider)}<strong>${escape(provider)}</strong></div>
                  <div class="provider-meta">
                    <button type="button" class="icon-btn" data-open-modal="add-account-modal" data-provider="${escape(provider)}" title="Add ${escape(provider)} account" aria-label="Add ${escape(provider)} account">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                    <span class="pill ${summary.active > 0 ? 'ok' : ''}">${summary.active}/${summary.total} active</span>
                    <span class="pill">${providerRequests} req</span>
                  </div>
                </div>
                <div class="accounts-grid">
                  ${summary.accounts.map((account, index) => {
                    const accUsage = providerUsage[provider]?.[account.file] ?? providerUsage[provider]?.[account.display_name]
                    const isEnabled = !account.expired
                    const nextIndex = summary.accounts.findIndex((acc) => !acc.expired)
                    const isNext = index === nextIndex && isEnabled
                    const accountHits = usage.account_counts?.[provider]?.[account.file] ?? 0
                    const used = accUsage?.primaryUsedPercent
                    const remaining = typeof used === 'number' ? Math.max(0, Math.min(100, 100 - used)) : undefined
                    const tone = remaining === undefined ? 'muted' : remaining <= 10 ? 'danger' : remaining <= 30 ? 'warn' : 'ok'
                    return `<div class="account ${isNext ? 'account-next' : ''}">
                      <div class="account-top">
                        <div class="account-info">
                          ${isNext ? '<span class="badge-next" title="Next account in rotation">Next</span>' : `<span class="badge-order">#${index + 1}</span>`}
                          <div>
                            <div class="account-name" title="${escape(account.file)}">${escape(account.display_name)}</div>
                          </div>
                        </div>
                        <div class="account-controls">
                          <span class="pill" title="Requests routed via this account">${accountHits} req</span>
                          <form method="post" action="/relay/accounts/toggle" data-async class="switch-form">
                            <input type="hidden" name="accountFile" value="${escape(account.file)}" />
                            <input type="hidden" name="enabled" value="${account.expired ? 'true' : 'false'}" />
                            <button type="submit" class="switch ${isEnabled ? 'on' : 'off'}" title="${isEnabled ? 'Disable account' : 'Enable account'}" aria-label="${isEnabled ? 'Disable account' : 'Enable account'}">
                              <span class="switch-knob"></span>
                              <span class="sr-only">${isEnabled ? 'Disable account' : 'Enable account'}</span>
                            </button>
                          </form>
                        </div>
                      </div>
                      ${accUsage ? (() => {
                        const weeklyUsed = accUsage.secondaryUsedPercent
                        const weeklyLeft = typeof weeklyUsed === 'number' ? Math.max(0, Math.min(100, 100 - weeklyUsed)) : undefined
                        const weeklyTone = weeklyLeft === undefined ? 'muted' : weeklyLeft <= 10 ? 'danger' : weeklyLeft <= 30 ? 'warn' : 'ok'
                        return `<div class="account-metrics">
                          <div class="metric-row">
                            <span class="metric-key">5h</span>
                            <span class="usage-dot ${tone}"></span>
                            <span class="metric-val ${tone}">${remaining !== undefined ? `${remaining}% left` : '—'}</span>
                            <span class="metric-reset muted">resets in ${formatReset(accUsage.primaryResetSeconds)}</span>
                          </div>
                          <div class="metric-row">
                            <span class="metric-key">Weekly</span>
                            <span class="usage-dot ${weeklyTone}"></span>
                            <span class="metric-val ${weeklyTone}">${weeklyLeft !== undefined ? `${weeklyLeft}% left` : '—'}</span>
                            <span class="metric-reset muted">resets in ${formatReset(accUsage.secondaryResetSeconds)}</span>
                          </div>
                        </div>`
                      })() : ''}
                    </div>`
                  }).join('')}
                </div>
              </div>`
            }).join('')}
          </div>
        </div>
      </div>

      <div id="tab-groups" class="tab-panel">
        <div class="card">
          <div class="card-head">
            <h2>Model Groups</h2>
            <div class="actions">
              <span class="sub">${modelGroupEntries.length} total · round-robin with failover</span>
              <button type="button" class="btn primary" data-open-modal="group-modal">+ Add Group</button>
            </div>
          </div>
            <div class="card-body">
              ${modelGroupEntries.length === 0 ? `<p class="empty">No model groups. Click + Add Group.</p>` : `<div class="list">${modelGroupEntries.map((group) => {
                const lastHit = status.model_groups.last_hit_by_group_id[group.id]
                const inCatalog = groupsPresent(group.name)
                const isLocked = ['4EEBCEE0-55B6-4A4F-B875-C95A3DDFD54E', '1CB78ECB-A1D4-4C37-B9CD-26A77DD428F6', '3633277B-8B99-4DC1-8FB4-656E1B752AB1'].includes(group.id)
                return `<div class="group-item">
                  <div class="group-head">
                    <div>
                      <div class="group-name">${escape(group.name)} ${isLocked ? '<span class="pill">locked</span>' : ''} ${inCatalog ? '<span class="pill ok" title="Visible in /v1/models">/v1</span>' : ''}</div>
                      <div class="group-id">${escape(group.id)} · ${lastHit ? `last: ${escape(lastHit)}` : 'unused yet'}</div>
                    </div>
                    <div class="actions">
                      <form method="post" action="/relay/model-groups" data-async style="display:inline;">
                        <input type="hidden" name="groupId" value="${escape(group.id)}" />
                        <input type="hidden" name="groupName" value="${escape(group.name)}" />
                        <input type="hidden" name="groupModels" value="${escape(group.models.join(','))}" />
                        <input type="hidden" name="enabled" value="${group.enabled ? 'false' : 'true'}" />
                        <button type="submit" class="switch ${group.enabled ? 'on' : 'off'}" title="${group.enabled ? 'Disable group' : 'Enable group'}"><span class="switch-knob"></span><span class="sr-only">${group.enabled ? 'Disable group' : 'Enable group'}</span></button>
                      </form>
                      ${isLocked ? '' : `<button type="button" class="icon-btn" data-edit-group='${escape(JSON.stringify(group))}' title="Edit group">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                      </button>
                      <form method="post" action="/relay/model-groups/${escape(group.id)}" data-async data-confirm="Delete group ${escape(group.name)}?" style="display:inline; opacity:1;">
                        <button type="submit" class="icon-btn trash" title="Remove group" aria-label="Remove group">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                        </button>
                      </form>`}
                    </div>
                  </div>
                  <div class="group-models">${group.models.map((model) => `<span class="chip">${escape(model)}</span>`).join('')}</div>
                </div>`
              }).join('')}</div>`}
            </div>
          </div>

        <div class="card" style="margin-top:14px;">
          <div class="card-head">
            <h2>Custom Models</h2>
            <div class="actions">
              <span class="sub">Add Ollama / OpenCode / NVIDIA / local models manually</span>
              <button type="button" class="btn" data-open-modal="custom-model-modal">+ Add Model</button>
            </div>
          </div>
          <div class="card-body">
            ${(settings?.customModels ?? []).length === 0 ? '<p class="empty">No custom models yet. They will appear in /v1/models and the picker above.</p>' : `<div class="list">${(settings!.customModels ?? []).map((entry: { owner: string, id: string }) => `<div class="row"><span class="mono">${providerIcon(entry.owner)} ${escape(entry.owner)}/${escape(entry.id)}</span><form method="post" action="/relay/custom-models/delete" data-async class="trash-form" style="display:inline;"><input type="hidden" name="owner" value="${escape(entry.owner)}" /><input type="hidden" name="id" value="${escape(entry.id)}" /><button type="submit" class="icon-btn trash" title="Remove" aria-label="Remove"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></form></div>`).join('')}</div>`}
          </div>
        </div>

        <div class="card" style="margin-top:14px;">
          <div class="card-head"><h2>Models Catalog</h2><span class="sub">${allCatalogModels.length} models · ${catalogEntries.length} providers</span></div>
          <div class="card-body">
            ${catalogEntries.length === 0 ? '<p class="empty">No catalog yet. Start relay to populate models.</p>' : `<div class="list">${catalogEntries.map(([owner, models]) => `<details><summary>${providerIcon(owner)}<strong>${escape(owner)}</strong><span class="muted" style="margin-left:auto; font-size:11px;">${models.length} models</span></summary><div class="catalog-models mono">${models.map((model) => escape(model.id)).join('<br>')}</div></details>`).join('')}</div>`}
          </div>
        </div>
      </div>

      <div id="tab-usage" class="tab-panel">
        <div class="grid-3">
          <div class="card">
            <div class="card-head"><h2>By Provider</h2><span class="sub">request count</span></div>
            <div class="card-body">
              ${providerCountEntries.length === 0 ? '<p class="empty">No usage yet.</p>' : `<div class="list">${providerCountEntries.map(([name, count]) => {
                const maxCount = Math.max(...providerCountEntries.map((e) => e[1]))
                const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
                return `<div class="bar-row"><div class="bar-label"><span>${providerIcon(name)} ${escape(name)}</span><span class="bar-value">${count}</span></div><div class="bar"><div class="bar-fill ok" style="width:${pct}%"></div></div></div>`
              }).join('')}</div>`}
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Top Endpoints</h2><span class="sub">${usage.total_requests} total</span></div>
            <div class="card-body">
              ${endpointEntries.length === 0 ? '<p class="empty">No usage yet.</p>' : `<div class="list">${endpointEntries.map(([name, count]) => {
                const pct = usage.total_requests > 0 ? (count / usage.total_requests) * 100 : 0
                return `<div class="bar-row"><div class="bar-label"><span class="mono">${escape(name)}</span><span class="bar-value">${count}</span></div><div class="bar"><div class="bar-fill ok" style="width:${pct}%"></div></div></div>`
              }).join('')}</div>`}
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Top Models</h2><span class="sub">by resolution</span></div>
            <div class="card-body">
              ${modelEntries.length === 0 ? '<p class="empty">No resolutions yet.</p>' : `<div class="list">${modelEntries.map(([name, count]) => {
                const maxCount = Math.max(...modelEntries.map((entry) => entry[1]))
                const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
                return `<div class="bar-row"><div class="bar-label"><span class="mono">${escape(name)}</span><span class="bar-value">${count}</span></div><div class="bar"><div class="bar-fill ok" style="width:${pct}%"></div></div></div>`
              }).join('')}</div>`}
            </div>
          </div>
        </div>

        <div class="grid-3" style="margin-top:14px;">
          ${Object.keys(usage.account_counts ?? {}).length === 0 ? `<div class="card" style="grid-column: 1 / -1;"><div class="card-head"><h2>Requests per Account</h2></div><div class="card-body"><p class="empty">No account-scoped requests yet. Route a /v1/chat/completions or /v1/messages call to populate.</p></div></div>` : Object.entries(usage.account_counts ?? {}).map(([provider, accounts]) => {
            const entries = Object.entries(accounts).sort((l, r) => r[1] - l[1])
            const max = Math.max(...entries.map((entry) => entry[1]), 1)
            const total = entries.reduce((sum, entry) => sum + entry[1], 0)
            return `<div class="card">
              <div class="card-head">
                <h2>${providerIcon(provider)} ${escape(provider)}</h2>
                <span class="sub">${total} req</span>
              </div>
              <div class="card-body">
                <div class="list">${entries.map(([file, count]) => { const label = usage.account_labels?.[provider]?.[file] ?? file; return `<div class="bar-row"><div class="bar-label"><span title="${escape(file)}">${escape(label)}</span><span class="bar-value">${count}</span></div><div class="bar"><div class="bar-fill ok" style="width:${(count / max) * 100}%"></div></div></div>` }).join('')}</div>
              </div>
            </div>`
          }).join('')}
        </div>

        <div style="margin-top:14px;">
          ${orderedUsageProviders.length === 0 ? `<div class="card"><div class="card-head"><h2>Provider Usage Windows</h2></div><div class="card-body"><p class="empty">No provider usage windows available.</p></div></div>` : orderedUsageProviders.map((provider) => {
            const accounts = providerUsage[provider] ?? {}
            return `<section class="usage-provider-section">
              <div class="section-head">
                <div class="provider-title">${providerIcon(provider)}<strong>${escape(provider)}</strong></div>
                <span class="sub">${Object.keys(accounts).length} accounts</span>
              </div>
              <div class="accounts-grid">${Object.entries(accounts).map(([accountId, window]) => { const label = usage.account_labels?.[provider]?.[accountId] ?? accountId; return `<div class="account">
                <div class="account-top"><div><div class="account-name" title="${escape(accountId)}">${escape(label)}</div>${window.planType ? `<div class="muted" style="font-size:11px;">${escape(window.planType)}</div>` : ''}</div></div>
                <div class="account-usage">${bar('5h', window.primaryUsedPercent, window.primaryResetSeconds)}${bar('Weekly', window.secondaryUsedPercent, window.secondaryResetSeconds)}</div>
              </div>` }).join('')}</div>
            </section>`
          }).join('')}
        </div>
      </div>

      <div id="tab-providers" class="tab-panel">
        <div class="card">
          <div class="card-head"><h2>Provider Controls</h2><span class="sub">enable or disable whole providers</span></div>
          <div class="card-body">
            ${providerNames.length === 0 ? '<p class="empty">No providers detected.</p>' : `<div class="list">${providerNames.map((provider) => {
              const enabled = settings?.providerEnabled[provider] !== false
              return `<div class="row">
                <div class="provider-title">${providerIcon(provider)}<strong>${escape(provider)}</strong><span class="pill ${enabled ? 'ok' : ''}" style="margin-left:8px;">${enabled ? 'enabled' : 'disabled'}</span></div>
                <form method="post" action="/relay/providers/${escape(provider)}/toggle" data-async style="display:inline;">
                  <input type="hidden" name="provider" value="${escape(provider)}" />
                  <input type="hidden" name="enabled" value="${enabled ? 'false' : 'true'}" />
                  <button type="submit" class="switch ${enabled ? 'on' : 'off'}" title="${enabled ? 'Disable' : 'Enable'} ${escape(provider)}" aria-label="${enabled ? 'Disable' : 'Enable'} ${escape(provider)}">
                    <span class="switch-knob"></span>
                    <span class="sr-only">${enabled ? 'Disable' : 'Enable'} ${escape(provider)}</span>
                  </button>
                </form>
              </div>`
            }).join('')}</div>`}
          </div>
        </div>
      </div>

      <div id="tab-logs" class="tab-panel">
        <div class="card">
          <div class="card-head">
            <h2>Logs</h2>
            <div class="actions" style="gap:6px;">
              <label class="switch-label"><input type="checkbox" id="log-follow" checked /> Follow</label>
              <button type="button" class="btn ghost" id="log-clear">Clear</button>
            </div>
          </div>
          <div class="card-body" style="padding:0;">
            <div id="log-view" class="log-view"><div class="empty" style="padding:14px;">Waiting for logs…</div></div>
          </div>
        </div>
      </div>

      <div id="tab-utility" class="tab-panel">
        <div class="card">
          <div class="card-head"><h2>Utility</h2><span class="sub">raw endpoints</span></div>
          <div class="card-body">
            <div class="actions">
              <a class="btn" href="/status" target="_blank">/status</a>
              <a class="btn" href="/accounts" target="_blank">/accounts</a>
              <a class="btn" href="/usage" target="_blank">/usage</a>
              <a class="btn" href="/v1/models" target="_blank">/v1/models</a>
              <a class="btn" href="/relay/state" target="_blank">/relay/state</a>
              <a class="btn" href="/dashboard">Refresh now</a>
              <button type="button" class="btn" data-act="relay-start" data-action="start">Start relay</button>
              <button type="button" class="btn danger" data-act="relay-stop" data-action="stop">Stop relay</button>
            </div>
            <p class="muted" style="margin-top:12px; font-size:11px;">Generated ${escape(status.generated_at)}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="modal" id="group-modal" data-catalog='${catalogJson.replace(/'/g, '&#39;')}' hidden>
      <div class="modal-backdrop" data-close-modal></div>
      <div class="modal-card">
        <div class="modal-head">
          <h2 id="group-modal-title">Add Model Group</h2>
          <span class="sr-only">Model Group Editor</span>
          <button type="button" class="icon-btn" data-close-modal aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <form method="post" action="/relay/model-groups" data-async id="group-form" data-keep-modal class="modal-body">
          <input type="hidden" name="groupId" id="group-id-field" />
          <label class="field-label">Alias <span class="muted">(e.g. <span class="kbd">high</span>, routes requests for this model name)</span></label>
          <input type="text" name="groupName" id="group-name-field" required pattern="^[a-zA-Z0-9_\\-\\.]+$" title="No spaces. Letters, digits, - _ . only." placeholder="alias-name-no-spaces" />
          <div id="group-name-error" class="field-error"></div>

          <label class="field-label" style="margin-top:10px;">Models in this alias <span class="muted">(round-robin, auto-failover)</span></label>
          <div class="chips-input-wrap">
            <div class="chips" id="group-chips"></div>
            <input type="hidden" name="groupModels" id="group-models" />
          </div>

          <label class="field-label" style="margin-top:8px;">Add model</label>
          <div class="form-row">
            <input type="search" id="model-search" placeholder="Search ${allCatalogModels.length} available models..." autocomplete="off" />
            <button type="button" id="model-add-btn" class="btn">Add</button>
          </div>
          <div id="model-suggest" class="suggest" hidden></div>

          <div class="or-sep">— or enter manually —</div>
          <div class="form-row">
            <input type="text" id="manual-owner" placeholder="owner (e.g. ollama)" style="flex:0 0 130px;" />
            <input type="text" id="manual-id" placeholder="model id (e.g. llama3.2)" style="flex:1;" />
            <button type="button" id="manual-validate" class="btn">Validate</button>
            <button type="button" id="manual-add" class="btn primary" disabled>Add</button>
          </div>
          <div id="manual-status" class="field-hint"></div>

          <div class="modal-actions">
            <label class="switch-label"><input type="checkbox" name="enabled" value="true" checked /> Enabled</label>
            <div style="flex:1;"></div>
            <button type="button" class="btn" data-close-modal>Cancel</button>
            <button type="submit" class="btn primary">Save group</button>
          </div>
        </form>
      </div>
    </div>

    <div class="modal" id="custom-model-modal" hidden>
      <div class="modal-backdrop" data-close-modal></div>
      <div class="modal-card">
        <div class="modal-head">
          <h2>Add Custom Model</h2>
          <button type="button" class="icon-btn" data-close-modal aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <form method="post" action="/relay/custom-models" data-async data-keep-modal class="modal-body">
          <label class="field-label">Owner / provider id</label>
          <input type="text" name="owner" required placeholder="ollama, opencode, nvidia, ..." />
          <label class="field-label" style="margin-top:10px;">Model id</label>
          <input type="text" name="id" required placeholder="llama3.2, codestral, ..." />
          <div class="field-hint muted">This model will appear in /v1/models and in the group picker. Useful for local runtimes (Ollama) or providers not auto-discovered.</div>
          <div class="modal-actions">
            <div style="flex:1;"></div>
            <button type="button" class="btn" data-close-modal>Cancel</button>
            <button type="submit" class="btn primary">Add model</button>
          </div>
        </form>
      </div>
    </div>

    <div class="modal" id="account-settings-modal" hidden>
      <div class="modal-backdrop" data-close-modal></div>
      <div class="modal-card">
        <div class="modal-head">
          <h2>Account Settings</h2>
          <button type="button" class="icon-btn" data-close-modal aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          ${providerEntries.length === 0 ? '<p class="empty">No accounts available.</p>' : providerEntries.map(([provider, summary]) => `<section class="provider-group"><div class="provider-head"><div class="provider-title">${providerIcon(provider)}<strong>${escape(provider)}</strong></div><span class="sub">${summary.accounts.length} accounts</span></div><div class="list">${summary.accounts.map((account) => `<div class="row"><div><div>${escape(account.display_name)}</div><div class="muted" style="font-size:11px;">${escape(account.file)}</div></div><form method="post" action="/relay/accounts/remove" data-async data-confirm="Remove ${escape(account.display_name)}?" style="display:inline;"><input type="hidden" name="accountFile" value="${escape(account.file)}" /><button type="submit" class="btn danger">Delete</button></form></div>`).join('')}</div></section>`).join('')}
        </div>
      </div>
    </div>

    <div class="modal" id="add-account-modal" hidden>
      <div class="modal-backdrop" data-close-modal></div>
      <div class="modal-card" style="max-width: 480px;">
        <div class="modal-head">
          <h2>Add Account</h2>
          <button type="button" class="icon-btn" data-close-modal aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <form method="post" action="/relay/accounts/add" data-async data-keep-modal id="add-account-form" class="modal-body">
          <input type="hidden" name="provider" id="add-account-provider" />
          <div class="field-label">Provider</div>
          <div id="add-account-provider-label" class="row" style="justify-content:flex-start; margin-bottom:10px;"></div>
          <div id="add-account-oauth-help" class="field-hint muted">Browser login flow.</div>
          <div id="add-account-key-wrap" hidden>
            <label class="field-label" style="margin-top:10px;">API key</label>
            <input type="password" name="apiKey" id="add-account-api-key" placeholder="Paste API key" />
            <div class="field-hint muted">Saved into ~/.cli-proxy-api as provider auth JSON.</div>
          </div>
          <div class="modal-actions">
            <div style="flex:1;"></div>
            <button type="button" class="btn" data-close-modal>Cancel</button>
            <button type="submit" class="btn primary">Continue</button>
          </div>
        </form>
      </div>
    </div>
  `
}

const STYLES = `
:root {
  color-scheme: dark;
  --bg: #14120B; --panel: #1A1913; --panel-2: #1F1D16;
  --border: #2A281E; --border-strong: #3A3829;
  --text: #ffffff; --muted: rgba(255,255,255,.62); --muted-2: rgba(255,255,255,.40);
  --accent: #ffffff; --accent-hover: rgba(255,255,255,.85); --accent-soft: rgba(255,255,255,.10);
  --ok: #7FC97F; --ok-soft: rgba(127,201,127,.14);
  --warn: #E8B547; --warn-soft: rgba(232,181,71,.14);
  --danger: #E86B4F; --danger-soft: rgba(232,107,79,.14);
  --radius: 8px; --radius-lg: 12px;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter", sans-serif; background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.small { font-size: 12px; }
.muted { color: var(--muted); }
.shell { max-width: 1200px; margin: 0 auto; padding: 18px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }

.topbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 12px; }
.topbar-left { display: flex; align-items: center; gap: 10px; }
.topbar h1.wordmark { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: 0.28em; color: var(--accent); }
.topbar .sub { color: var(--muted); font-size: 11px; }
.topbar-right { display: flex; align-items: center; gap: 8px; }

.status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.status-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; }
.status-badge.running { background: var(--ok-soft); color: var(--ok); }
.status-badge.running::before { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.status-badge.stopped { background: var(--danger-soft); color: var(--danger); }
.status-badge.stopped::before { background: var(--danger); }

.metrics { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 12px; }
.metric { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
.metric .k { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.metric .v { font-size: 18px; font-weight: 600; margin-top: 2px; letter-spacing: -0.02em; }

.tabs { display: flex; gap: 2px; padding: 3px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; width: fit-content; }
.tab { background: transparent; border: 0; color: var(--muted); font-size: 12px; font-weight: 500; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-family: inherit; }
.tab:hover { color: var(--text); }
.tab.active { background: var(--accent-soft); color: var(--accent); box-shadow: inset 0 0 0 1px rgba(255,255,255,.2); }

.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
@media (max-width: 1000px) { .grid-3 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 860px) { .metrics { grid-template-columns: repeat(2, 1fr); } .grid-2 { grid-template-columns: 1fr; } .grid-3 { grid-template-columns: 1fr; } }

.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
.card-head { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.card-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.005em; }
.card-head .sub { color: var(--muted); font-size: 11px; font-weight: 400; line-height: 1; }
.icon-btn { vertical-align: middle; }
.card-body { padding: 12px 14px; }

.list { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.card-head > .actions { min-height: 24px; }
.actions-row { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }
.quick-add-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }

.pill { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); }
.pill.ok { background: var(--ok-soft); color: var(--ok); border-color: rgba(127,201,127,.3); }
.pill.warn { background: var(--warn-soft); color: var(--warn); border-color: rgba(232,181,71,.3); }
.pill.danger, .pill.expired { background: var(--danger-soft); color: var(--danger); border-color: rgba(232,107,79,.3); }

.btn, button.btn, a.btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; background: var(--panel-2); color: var(--text); border: 1px solid var(--border); padding: 6px 10px; border-radius: 7px; font-size: 11px; font-weight: 500; cursor: pointer; font-family: inherit; text-decoration: none; transition: all 0.1s; }
.btn:hover { background: var(--border); border-color: var(--border-strong); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--bg); }
.btn.danger { color: var(--danger); border-color: rgba(232,107,79,.3); }
.btn.danger:hover { background: var(--danger-soft); border-color: var(--danger); }
.btn.ghost { background: transparent; }

input[type=text], input[type=number], select { width: 100%; padding: 7px 10px; font-size: 12px; font-family: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 7px; }
input[type=text]:focus, input[type=number]:focus { outline: none; border-color: var(--accent); }

.empty { color: var(--muted); font-size: 12px; padding: 4px 0; }
.kbd { font-family: ui-monospace, monospace; font-size: 10px; padding: 1px 5px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; color: var(--muted); }

.provider-group { margin-bottom: 12px; }
.provider-group:last-child { margin-bottom: 0; }
.usage-provider-section { margin-top: 14px; }
.usage-provider-section:first-child { margin-top: 0; }
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; padding: 0 2px; }
.provider-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; padding: 0 2px; }
.provider-title { display: flex; align-items: center; gap: 8px; }
.provider-title strong { font-size: 12px; text-transform: capitalize; }
.provider-meta { display: flex; gap: 4px; }
.provider-icon { width: 16px; height: 16px; border-radius: 4px; object-fit: cover; background: var(--panel-2); }
.provider-icon-fallback { display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: var(--accent); border: 1px solid var(--border); }

.accounts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; }
.account { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; position: relative; }
.account:hover .trash-form { opacity: 1; }
.account-next { border-color: var(--border); box-shadow: none; }
.account-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.account-info { display: flex; gap: 8px; align-items: flex-start; }
.badge-next, .badge-order { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 18px; padding: 0 5px; border-radius: 4px; font-size: 9px; font-weight: 700; letter-spacing: .04em; }
.badge-next { background: var(--accent-soft); color: var(--accent); text-transform: uppercase; }
.badge-order { background: var(--panel); color: var(--muted); border: 1px solid var(--border); }
.account-name { font-weight: 500; font-size: 12px; }
.account-file { color: var(--muted-2); font-size: 10px; font-family: ui-monospace, monospace; margin-top: 2px; word-break: break-all; }
.account-controls { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.trash-form { opacity: 0; transition: opacity .12s; }
.trash-form:focus-within { opacity: 1; }

.switch { position: relative; width: 32px; height: 18px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); cursor: pointer; transition: all .15s; padding: 0; }
.switch.on { background: var(--accent); border-color: var(--accent); }
.switch .switch-knob { position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 50%; background: rgba(255,255,255,.75); transition: transform .15s; }
.switch.on .switch-knob { transform: translateX(14px); background: var(--bg); }
.switch:hover { opacity: .9; }
.switch-label { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); cursor: pointer; }
.switch-label input { width: auto; }

.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--muted); cursor: pointer; }
.icon-btn:hover { background: var(--panel); color: var(--text); border-color: var(--border); }
.icon-btn.trash:hover { color: var(--danger); border-color: rgba(232,107,79,.4); }

.account-usage { display: flex; flex-direction: column; gap: 6px; }
.account-compact { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); padding-top: 4px; border-top: 1px dashed var(--border); }
.account-compact strong { font-size: 12px; color: var(--text); font-weight: 600; }
.account-metrics { display: flex; flex-direction: column; gap: 3px; padding-top: 6px; border-top: 1px dashed var(--border); font-size: 11px; }
.metric-row { display: flex; align-items: center; gap: 6px; }
.metric-key { width: 42px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.metric-val { font-weight: 600; }
.metric-val.ok { color: var(--ok); }
.metric-val.warn { color: var(--warn); }
.metric-val.danger { color: var(--danger); }
.metric-val.muted { color: var(--muted-2); font-weight: 400; }
.metric-reset { margin-left: auto; font-size: 10px; }
.usage-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.usage-dot.ok { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.usage-dot.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.usage-dot.danger { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.usage-dot.muted { background: var(--muted-2); }
.usage-reset { margin-left: auto; font-size: 11px; }
.bar-row { display: flex; flex-direction: column; gap: 3px; }
.bar-label { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
.bar-value { color: var(--text); font-weight: 500; }
.bar-reset { color: var(--muted-2); font-weight: 400; }
.bar { height: 4px; background: var(--border); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; transition: width .3s; }
.bar-fill.ok { background: var(--ok); }
.bar-fill.warn { background: var(--warn); }
.bar-fill.danger { background: var(--danger); }
.bar-fill.muted { background: var(--muted-2); }

.group-item { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.group-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.group-name { font-weight: 500; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.group-id { color: var(--muted-2); font-size: 10px; font-family: ui-monospace, monospace; margin-top: 2px; }
.group-models { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.chip { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 2px 7px; font-size: 10px; font-family: ui-monospace, monospace; color: var(--muted); }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 640px) { .form-grid { grid-template-columns: 1fr; } }
.model-select-wrap { display: flex; flex-direction: column; gap: 4px; }
.model-select-wrap select { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; min-height: 160px; }
.model-select-wrap select:focus { outline: none; border-color: var(--accent); }
.model-select-wrap select option { padding: 3px 6px; }
.model-select-wrap select option:checked { background: var(--accent); color: var(--bg); }
.model-select-wrap input[type=search] { width: 100%; padding: 7px 10px; font-size: 12px; font-family: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 7px; }
.model-select-wrap input[type=search]:focus { outline: none; border-color: var(--accent); }

details { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 4px; }
details summary { padding: 8px 12px; cursor: pointer; font-size: 11px; color: var(--muted); list-style: none; display: flex; align-items: center; gap: 8px; }
details summary::-webkit-details-marker { display: none; }
details[open] summary { border-bottom: 1px solid var(--border); }
.catalog-models { padding: 10px 12px; font-size: 10px; line-height: 1.7; color: var(--muted); max-height: 200px; overflow-y: auto; }

.log-view { max-height: 520px; overflow-y: auto; padding: 10px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: var(--bg); }
.log-entry { padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
.log-entry.stderr { color: var(--danger); }
.log-entry.stdout { color: var(--muted); }
.log-ts { color: var(--muted-2); margin-right: 8px; }

.toast { position: fixed; bottom: 16px; right: 16px; padding: 8px 12px; background: var(--panel); border: 1px solid var(--border-strong); border-radius: 8px; font-size: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.3); opacity: 0; transform: translateY(10px); transition: all .2s; z-index: 100; pointer-events: none; }
.toast.show { opacity: 1; transform: translateY(0); }
.toast.ok { border-color: rgba(127,201,127,.5); }
.toast.error { border-color: rgba(232,107,79,.5); }

.tab-panel { display: none; }
.tab-panel.active { display: block; }

.modal { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; }
.modal[hidden] { display: none; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(5,8,15,.7); backdrop-filter: blur(4px); }
.modal-card { position: relative; width: 90%; max-width: 560px; max-height: 90vh; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.6); overflow: hidden; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.modal-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.modal-body { padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; }
.modal-actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }

.field-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; display: block; }
.field-label .muted { font-weight: 400; }
.field-error { color: var(--danger); font-size: 11px; min-height: 14px; margin-top: 4px; }
.field-hint { font-size: 11px; margin-top: 6px; }
.field-hint.ok { color: var(--ok); }
.field-hint.warn { color: var(--warn); }
.field-hint.error { color: var(--danger); }
.form-row { display: flex; gap: 6px; align-items: stretch; }
.form-row input[type=text], .form-row input[type=search] { flex: 1; }

.or-sep { text-align: center; color: var(--muted-2); font-size: 10px; margin: 12px 0 8px; }

.chips-input-wrap { min-height: 40px; padding: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chips:empty::before { content: 'No models yet — add some below.'; color: var(--muted-2); font-size: 11px; padding: 4px; }
.chips .chip-active { background: var(--accent-soft); border: 1px solid rgba(255,255,255,.3); color: var(--accent); border-radius: 6px; padding: 2px 6px 2px 8px; font-size: 11px; font-family: ui-monospace, monospace; display: inline-flex; align-items: center; gap: 6px; }
.chips .chip-active button { background: transparent; border: 0; color: var(--accent); cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; }
.chips .chip-active button:hover { color: var(--danger); }

.suggest { position: relative; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; margin-top: 4px; max-height: 220px; overflow-y: auto; }
.suggest-item { padding: 6px 10px; font-size: 11px; font-family: ui-monospace, monospace; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
.suggest-item:hover, .suggest-item.active { background: var(--border); }
.suggest-empty { padding: 10px; color: var(--muted); font-size: 11px; }
`

const SCRIPT = `
(() => {
  const toastEl = document.getElementById('toast');
  function showToast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show ' + (kind || 'ok');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function activateTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    try { localStorage.setItem('vr-tab', name); } catch (_) {}
  }

  function currentTab() {
    try { return localStorage.getItem('vr-tab') || 'accounts'; } catch (_) { return 'accounts'; }
  }

  function wire() {
    activateTab(currentTab());
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => activateTab(t.dataset.tab));
    });

    document.querySelectorAll('form[data-async]').forEach((form) => {
      if (form._wired) return; form._wired = true;
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return;
        const body = new URLSearchParams();
        for (const [k, v] of new FormData(form).entries()) body.append(k, String(v));
        try {
          const res = await fetch(form.action, { method: form.method || 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
          if (!res.ok) throw new Error(res.status + '');
          showToast('Saved', 'ok');
          if (form.dataset.keepModal !== undefined) {
            const modal = form.closest('.modal');
            if (modal) closeModal(modal);
          }
          setTimeout(() => { if (!anyModalOpen()) refreshBody(); }, 300);
        } catch (e) { showToast('Failed: ' + e, 'error'); }
      });
    });

    document.querySelectorAll('[data-act]').forEach((btn) => {
      if (btn._wired) return; btn._wired = true;
      btn.addEventListener('click', async () => {
        const path = btn.dataset.act === 'relay-start' ? '/relay/start' : btn.dataset.act === 'relay-stop' ? '/relay/stop' : null;
        if (!path) return;
        try { const r = await fetch(path, { method: 'POST' }); if (!r.ok) throw new Error(); showToast('OK', 'ok'); await refreshBody(); } catch (_) { showToast('Failed', 'error'); }
      });
    });

    document.querySelectorAll('[data-edit-group]').forEach((btn) => {
      if (btn._wired) return; btn._wired = true;
      btn.addEventListener('click', () => {
        const g = JSON.parse(btn.dataset.editGroup);
        activateTab('groups');
        loadGroupForEdit(g);
      });
    });

    wireGroupModal();
    wireLogs();
  }

  // --- Modal system ---
  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    const first = m.querySelector('input[type=text], input[type=search], input[type=password]');
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal(m) { if (m) m.hidden = true; }
  function anyModalOpen() {
    return !!document.querySelector('.modal:not([hidden])');
  }
  function configureAddAccountModal(provider) {
    const form = document.getElementById('add-account-form');
    if (!form) return;
    const hidden = document.getElementById('add-account-provider');
    const label = document.getElementById('add-account-provider-label');
    const help = document.getElementById('add-account-oauth-help');
    const keyWrap = document.getElementById('add-account-key-wrap');
    const keyInput = document.getElementById('add-account-api-key');
    const oauthProviders = new Set(['claude', 'codex', 'github-copilot']);
    hidden.value = provider;
    label.innerHTML = '<div class="provider-title"><strong>' + escapeHtml(provider) + '</strong></div>';
    const needsKey = !oauthProviders.has(provider);
    keyWrap.hidden = !needsKey;
    keyInput.required = needsKey;
    keyInput.value = '';
    help.textContent = needsKey
      ? 'API key flow. Save auth JSON into ~/.cli-proxy-api.'
      : 'Browser login flow through cli-proxy-api-plus.';
  }

  document.addEventListener('click', (ev) => {
    const open = ev.target.closest('[data-open-modal]');
    if (open) {
      openModal(open.dataset.openModal);
      if (open.dataset.openModal === 'group-modal') resetGroupModal();
      if (open.dataset.openModal === 'add-account-modal') configureAddAccountModal(open.dataset.provider || 'claude');
      return;
    }
    const close = ev.target.closest('[data-close-modal]');
    if (close) { closeModal(close.closest('.modal')); return; }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      document.querySelectorAll('.modal:not([hidden])').forEach(closeModal);
    }
  });

  // --- Group modal: chips, catalog search, manual validation ---
  function resetGroupModal() {
    const form = document.getElementById('group-form');
    if (!form) return;
    if (!form.dataset.editing) {
      form.reset();
      document.getElementById('group-id-field').value = '';
      document.getElementById('group-models').value = '';
      document.getElementById('group-modal-title').textContent = 'Add Model Group';
    }
    delete form.dataset.editing;
    renderChips();
    const name = document.getElementById('group-name-field');
    if (name) name.focus();
  }

  function modelsList() {
    const field = document.getElementById('group-models');
    return (field && field.value ? field.value.split(',') : []).map((s) => s.trim()).filter(Boolean);
  }
  function setModels(list) {
    const field = document.getElementById('group-models');
    if (field) field.value = Array.from(new Set(list)).join(', ');
    renderChips();
  }
  function renderChips() {
    const host = document.getElementById('group-chips');
    if (!host) return;
    host.innerHTML = '';
    modelsList().forEach((m) => {
      const chip = document.createElement('span');
      chip.className = 'chip-active';
      chip.textContent = m;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.innerHTML = '&times;';
      rm.title = 'Remove';
      rm.addEventListener('click', () => {
        setModels(modelsList().filter((x) => x !== m));
      });
      chip.appendChild(rm);
      host.appendChild(chip);
    });
  }

  function wireGroupModal() {
    const modal = document.getElementById('group-modal');
    if (!modal || modal._wired) return;
    modal._wired = true;
    let catalog = [];
    try { catalog = JSON.parse(modal.dataset.catalog || '[]'); } catch (_) {}

    const search = document.getElementById('model-search');
    const suggest = document.getElementById('model-suggest');
    const addBtn = document.getElementById('model-add-btn');
    const manualOwner = document.getElementById('manual-owner');
    const manualId = document.getElementById('manual-id');
    const manualValidate = document.getElementById('manual-validate');
    const manualAdd = document.getElementById('manual-add');
    const manualStatus = document.getElementById('manual-status');
    const nameField = document.getElementById('group-name-field');
    const idField = document.getElementById('group-id-field');
    const nameErr = document.getElementById('group-name-error');

    const showSuggest = (q) => {
      const query = q.trim().toLowerCase();
      if (!query) { suggest.hidden = true; suggest.innerHTML = ''; return; }
      const current = new Set(modelsList());
      const matches = catalog
        .filter((m) => (m.owner + '/' + m.id).toLowerCase().includes(query))
        .filter((m) => !current.has(m.owner + '/' + m.id))
        .slice(0, 12);
      suggest.innerHTML = '';
      if (matches.length === 0) {
        suggest.innerHTML = '<div class="suggest-empty">No matches. Use manual entry below.</div>';
      } else {
        matches.forEach((m) => {
          const label = m.owner + '/' + m.id;
          const item = document.createElement('div');
          item.className = 'suggest-item';
          item.innerHTML = '<span>' + escapeHtml(label) + '</span><span class="muted" style="font-size:10px;">' + escapeHtml(m.owner) + '</span>';
          item.addEventListener('click', () => {
            setModels(modelsList().concat(label));
            search.value = '';
            suggest.hidden = true;
          });
          suggest.appendChild(item);
        });
      }
      suggest.hidden = false;
    };

    search.addEventListener('input', () => showSuggest(search.value));
    search.addEventListener('focus', () => showSuggest(search.value));
    search.addEventListener('blur', () => setTimeout(() => { suggest.hidden = true; }, 150));
    addBtn.addEventListener('click', () => {
      const q = search.value.trim();
      if (!q) return;
      const label = q.includes('/') ? q : catalog.find((m) => m.id === q) ? catalog.find((m) => m.id === q).owner + '/' + q : q;
      setModels(modelsList().concat(label));
      search.value = '';
      suggest.hidden = true;
    });

    const updateManualState = () => {
      manualAdd.disabled = !manualStatus.classList.contains('ok');
    };
    const resetManualStatus = () => { manualStatus.textContent = ''; manualStatus.className = 'field-hint'; manualAdd.disabled = true; };
    manualOwner.addEventListener('input', resetManualStatus);
    manualId.addEventListener('input', resetManualStatus);
    manualValidate.addEventListener('click', async () => {
      const owner = manualOwner.value.trim();
      const id = manualId.value.trim();
      if (!owner || !id) { manualStatus.textContent = 'Owner and id required.'; manualStatus.className = 'field-hint error'; return; }
      manualStatus.textContent = 'Checking…'; manualStatus.className = 'field-hint';
      try {
        const res = await fetch('/relay/validate-model?owner=' + encodeURIComponent(owner) + '&id=' + encodeURIComponent(id));
        const data = await res.json();
        if (data.exists) { manualStatus.textContent = '✓ ' + data.label + ' found in catalog.'; manualStatus.className = 'field-hint ok'; }
        else { manualStatus.textContent = '⚠ ' + data.label + ' not in catalog. Add anyway?'; manualStatus.className = 'field-hint warn'; }
        manualAdd.disabled = false;
      } catch (_) {
        manualStatus.textContent = 'Validation failed.'; manualStatus.className = 'field-hint error';
      }
    });
    manualAdd.addEventListener('click', () => {
      const owner = manualOwner.value.trim();
      const id = manualId.value.trim();
      if (!owner || !id) return;
      setModels(modelsList().concat(owner + '/' + id));
      manualOwner.value = ''; manualId.value = '';
      resetManualStatus();
    });

    nameField.addEventListener('input', () => {
      const value = nameField.value;
      const ok = /^[a-zA-Z0-9_\\-\\.]+$/.test(value);
      nameErr.textContent = ok || value === '' ? '' : 'No spaces. Use letters, digits, - _ . only.';
      if (!idField.value || idField.dataset.auto === '1') {
        idField.value = value;
        idField.dataset.auto = '1';
      }
    });

    // Intercept submit to validate and reuse existing async form handler
    const form = document.getElementById('group-form');
    form.addEventListener('submit', (ev) => {
      if (!/^[a-zA-Z0-9_\\-\\.]+$/.test(nameField.value)) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        nameErr.textContent = 'Alias is required and must not contain spaces.';
        return;
      }
      if (modelsList().length === 0) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        nameErr.textContent = 'Add at least one model to the group.';
        return;
      }
      if (!idField.value) idField.value = nameField.value;
      setTimeout(() => closeModal(modal), 350);
    }, true);
  }

  function loadGroupForEdit(group) {
    openModal('group-modal');
    const form = document.getElementById('group-form');
    form.dataset.editing = '1';
    document.getElementById('group-modal-title').textContent = 'Edit Model Group';
    document.getElementById('group-id-field').value = group.id;
    document.getElementById('group-name-field').value = group.name;
    document.getElementById('group-models').value = group.models.join(', ');
    form.enabled.checked = !!group.enabled;
    renderChips();
  }

  async function refreshBody() {
    if (anyModalOpen()) return;
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    try {
      const res = await fetch('/dashboard?_=' + Date.now(), { headers: { 'accept': 'text/html', 'cache-control': 'no-cache' } });
      if (!res.ok) return;
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const fresh = doc.getElementById('app-body');
      const current = document.getElementById('app-body');
      if (!fresh || !current) return;
      const scrollY = window.scrollY;
      const currentLogView = document.getElementById('log-view');
      const logState = currentLogView
        ? {
            html: currentLogView.innerHTML,
            scrollTop: currentLogView.scrollTop,
            followChecked: document.getElementById('log-follow')?.checked ?? logsFollow,
          }
        : null;
      current.innerHTML = fresh.innerHTML;
      if (logState) {
        const nextLogView = document.getElementById('log-view');
        const nextLogFollow = document.getElementById('log-follow');
        if (nextLogView) {
          nextLogView.innerHTML = logState.html;
          nextLogView.scrollTop = logState.scrollTop;
        }
        if (nextLogFollow) nextLogFollow.checked = logState.followChecked;
        logsFollow = logState.followChecked;
      }
      wire();
      window.scrollTo(0, scrollY);
    } catch (_) {}
  }

  let logsSince = 0;
  let logsFollow = true;
  let logsPaused = false;
  async function pollLogs() {
    const tab = document.getElementById('tab-logs');
    if (!tab || !tab.classList.contains('active')) return;
    if (logsPaused) return;
    try {
      const res = await fetch('/relay/logs?since=' + logsSince);
      if (!res.ok) return;
      const data = await res.json();
      const view = document.getElementById('log-view');
      if (!view) return;
      if (data.entries && data.entries.length > 0) {
        if (view.querySelector('.empty')) view.innerHTML = '';
        const frag = document.createDocumentFragment();
        data.entries.forEach((e) => {
          const row = document.createElement('div');
          row.className = 'log-entry ' + e.stream;
          const ts = new Date(e.ts);
          row.innerHTML = '<span class="log-ts">' + ts.toLocaleTimeString() + '</span>' + escapeHtml(e.line);
          frag.appendChild(row);
        });
        view.appendChild(frag);
        if (logsFollow) view.scrollTop = view.scrollHeight;
        // Cap DOM nodes
        while (view.childNodes.length > 600) view.removeChild(view.firstChild);
      }
      if (typeof data.lastId === 'number') logsSince = data.lastId;
    } catch (_) {}
  }

  function wireLogs() {
    const follow = document.getElementById('log-follow');
    const clear = document.getElementById('log-clear');
    if (follow) follow.addEventListener('change', () => { logsFollow = follow.checked; });
    if (clear) clear.addEventListener('click', () => { const v = document.getElementById('log-view'); if (v) v.innerHTML = ''; });
  }

  function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  // Pause full-body refresh when typing or modal open
  function refreshPaused() {
    if (anyModalOpen()) return true;
    return !!(document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName));
  }

  function pollDashboard() {
    if (!refreshPaused()) refreshBody();
    setTimeout(pollDashboard, 5000);
  }

  wire();
  setTimeout(pollDashboard, 5000);
  setInterval(pollLogs, 1500);
})();
`
