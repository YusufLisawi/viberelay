import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

interface OpenClawCommandOptions {
  argv?: string[]
  baseUrl?: string
  configPath?: string
}

const DEFAULT_TOKEN = 'viberelay-local'
const DEFAULT_PROVIDER_ID = 'viberelay'

function helpText(): string {
  return `viberelay openclaw — wire OpenClaw at viberelay's local proxy

Usage:
  viberelay openclaw setup [opts]    Add a viberelay provider to ~/.openclaw/openclaw.json
  viberelay openclaw refresh         Re-pull live model groups from a running daemon
  viberelay openclaw status          Show whether openclaw points at viberelay
  viberelay openclaw print           Print the JSON snippet without writing

By default, setup queries the running viberelay daemon at --base-url and writes
every model group + the base claude/gpt models it currently exposes. New groups
you add later show up the next time you run \`viberelay openclaw refresh\`.

In OpenClaw chat (Telegram included): /model viberelay/high, /model viberelay/mid,
/model viberelay/low — or any model id viberelay exposes.

Setup options:
  --base-url <url>      Override viberelay base URL (default http://127.0.0.1:8327)
  --provider-id <id>    Provider key in openclaw config (default \`viberelay\`)
  --token <token>       API key openclaw sends (default \`viberelay-local\`)
  --set-default-model <id>   Also set openclaw's agent.model to viberelay/<id>
  --static              Skip daemon discovery, use a baked-in default list
  --config <path>       Override openclaw config path (default ~/.openclaw/openclaw.json)

Notes:
  Existing openclaw config is merged — other providers, agent settings, and
  unrelated keys are preserved. A timestamped backup is written next to the
  file before any change.`
}

interface ParsedArgs {
  sub: 'setup' | 'refresh' | 'status' | 'print' | 'help'
  baseUrl: string
  providerId: string
  token: string
  defaultModel?: string
  configPath: string
  useStaticModels: boolean
}

function parseArgs(argv: string[], defaults: { baseUrl: string, configPath: string }): ParsedArgs {
  const sub = (argv[0] ?? 'help') as ParsedArgs['sub']
  if (!['setup', 'refresh', 'status', 'print', 'help'].includes(sub)) {
    throw new Error(`unknown subcommand: ${sub}`)
  }

  let baseUrl = defaults.baseUrl
  let providerId = DEFAULT_PROVIDER_ID
  let token = DEFAULT_TOKEN
  let defaultModel: string | undefined
  let configPath = defaults.configPath
  let useStaticModels = false

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--base-url') baseUrl = next()
    else if (arg === '--provider-id') providerId = next()
    else if (arg === '--token') token = next()
    else if (arg === '--set-default-model') defaultModel = next()
    else if (arg === '--config') configPath = next()
    else if (arg === '--static') useStaticModels = true
    else throw new Error(`unknown flag: ${arg}`)
  }

  return { sub, baseUrl, providerId, token, defaultModel, configPath, useStaticModels }
}

interface OpenClawConfig {
  agent?: { model?: string, [key: string]: unknown }
  models?: {
    providers?: Record<string, {
      baseUrl?: string
      apiKey?: string
      models?: Record<string, Record<string, unknown>>
      [key: string]: unknown
    }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

async function loadExistingConfig(path: string): Promise<OpenClawConfig> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as OpenClawConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`failed to read ${path}: ${(error as Error).message}`)
  }
}

const STATIC_MODELS = [
  'high', 'mid', 'low',
  'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5',
  'openai/gpt-5.4-reasoning-high', 'openai/gpt-5.4-reasoning-low', 'openai/gpt-5.4-mini'
]

interface CatalogEntry { id: string, owned_by?: string }

async function discoverModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`)
    if (!res.ok) return null
    const payload = await res.json() as { data?: CatalogEntry[] }
    if (!Array.isArray(payload.data)) return null

    const groups = payload.data
      .filter((entry) => entry.owned_by === 'viberelay')
      .map((entry) => entry.id)
      .sort()

    // Pick clean base ids only — skip the noisy thinking/effort/reasoning variants
    // since openclaw users can append those suffixes themselves if they need them.
    const claudeBases = payload.data
      .filter((entry) => entry.owned_by === 'anthropic' &&
        /^claude-(?:opus|sonnet|haiku)-[\d-]+$/.test(entry.id))
      .map((entry) => entry.id)
      .sort()

    const gptBases = payload.data
      .filter((entry) => entry.owned_by === 'openai' &&
        /^gpt-[\d.]+(?:-(?:mini|nano|codex))?$/.test(entry.id))
      .map((entry) => entry.id)
      .sort()

    const all = [...new Set([...groups, ...claudeBases, ...gptBases])]
    return all.length > 0 ? all : null
  } catch {
    return null
  }
}

function viberelayProviderBlock(args: ParsedArgs, modelIds: string[]) {
  const baseUrl = args.baseUrl.endsWith('/v1')
    ? args.baseUrl
    : `${args.baseUrl.replace(/\/$/, '')}/v1`
  const models: Record<string, Record<string, unknown>> = {}
  for (const id of modelIds) models[id] = {}
  return { baseUrl, apiKey: args.token, models }
}

async function resolveModels(args: ParsedArgs): Promise<{ ids: string[], source: 'live' | 'static' }> {
  if (args.useStaticModels) return { ids: STATIC_MODELS, source: 'static' }
  const live = await discoverModels(args.baseUrl)
  if (live && live.length > 0) return { ids: live, source: 'live' }
  return { ids: STATIC_MODELS, source: 'static' }
}

function mergeConfig(existing: OpenClawConfig, args: ParsedArgs, modelIds: string[]): OpenClawConfig {
  const merged: OpenClawConfig = { ...existing }
  const models = { ...(merged.models ?? {}) }
  const providers = { ...(models.providers ?? {}) }
  providers[args.providerId] = viberelayProviderBlock(args, modelIds)
  models.providers = providers
  merged.models = models

  if (args.defaultModel) {
    const agent = { ...(merged.agent ?? {}) }
    agent.model = `${args.providerId}/${args.defaultModel}`
    merged.agent = agent
  }

  return merged
}

export async function runOpenClawCommand(options: OpenClawCommandOptions = {}): Promise<string> {
  const argv = options.argv ?? process.argv.slice(3)
  if (argv.length === 0) return helpText()

  const defaults = {
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:8327',
    configPath: options.configPath ?? join(homedir(), '.openclaw', 'openclaw.json')
  }

  const args = parseArgs(argv, defaults)

  if (args.sub === 'help') return helpText()

  if (args.sub === 'print') {
    const { ids } = await resolveModels(args)
    const block = { models: { providers: { [args.providerId]: viberelayProviderBlock(args, ids) } } }
    return JSON.stringify(block, null, 2)
  }

  const existing = await loadExistingConfig(args.configPath)

  if (args.sub === 'status') {
    const provider = existing.models?.providers?.[args.providerId]
    if (!provider) return `openclaw is NOT wired at ${args.configPath} (no provider \`${args.providerId}\`)`
    const modelIds = Object.keys(provider.models ?? {})
    const groups = modelIds.filter((id) => !id.includes('/') && !id.startsWith('claude-') && !id.startsWith('gpt-'))
    const lines = [
      `openclaw is wired at ${args.configPath}`,
      `  provider: ${args.providerId}`,
      `  baseUrl:  ${provider.baseUrl ?? '(missing)'}`,
      `  apiKey:   ${provider.apiKey ? '(set)' : '(missing)'}`,
      `  models:   ${modelIds.length} configured`
    ]
    if (groups.length > 0) lines.push(`  groups:   ${groups.join(', ')}`)
    if (existing.agent?.model) lines.push(`  agent.model: ${existing.agent.model}`)
    return lines.join('\n')
  }

  // setup / refresh
  const { ids: modelIds, source } = await resolveModels(args)
  await mkdir(dirname(args.configPath), { recursive: true })
  try {
    await copyFile(args.configPath, `${args.configPath}.${Date.now()}.bak`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const merged = mergeConfig(existing, args, modelIds)
  await writeFile(args.configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

  const groups = modelIds.filter((id) => !id.includes('/') && !id.startsWith('claude-') && !id.startsWith('gpt-'))
  const lines = [
    `✓ wrote ${args.configPath}  (${source} catalog, ${modelIds.length} models)`,
    `  provider \`${args.providerId}\` → ${viberelayProviderBlock(args, []).baseUrl}`
  ]
  if (groups.length > 0) lines.push(`  groups:      ${groups.join(', ')}`)
  if (args.defaultModel) lines.push(`  agent.model = ${args.providerId}/${args.defaultModel}`)
  if (source === 'static') lines.push(`  (daemon was unreachable — start viberelay then \`viberelay openclaw refresh\` to pull live groups)`)
  lines.push(`  switch in chat: /model ${args.providerId}/<id>  (e.g. /model ${args.providerId}/${groups[0] ?? 'claude-sonnet-4-5'})`)
  return lines.join('\n')
}
