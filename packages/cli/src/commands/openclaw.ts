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
  viberelay openclaw status          Show whether openclaw points at viberelay
  viberelay openclaw print           Print the JSON snippet without writing

Setup options:
  --base-url <url>      Override viberelay base URL (default http://127.0.0.1:8327)
  --provider-id <id>    Provider key in openclaw config (default \`viberelay\`)
  --token <token>       API key openclaw sends (default \`viberelay-local\`)
  --set-default-model <id>   Also set openclaw's agent.model to viberelay/<id>
  --config <path>       Override openclaw config path (default ~/.openclaw/openclaw.json)

Notes:
  Existing openclaw config is merged — other providers, agent settings, and
  unrelated keys are preserved. A timestamped backup is written next to the
  file before any change.`
}

interface ParsedArgs {
  sub: 'setup' | 'status' | 'print' | 'help'
  baseUrl: string
  providerId: string
  token: string
  defaultModel?: string
  configPath: string
}

function parseArgs(argv: string[], defaults: { baseUrl: string, configPath: string }): ParsedArgs {
  const sub = (argv[0] ?? 'help') as ParsedArgs['sub']
  if (!['setup', 'status', 'print', 'help'].includes(sub)) {
    throw new Error(`unknown subcommand: ${sub}`)
  }

  let baseUrl = defaults.baseUrl
  let providerId = DEFAULT_PROVIDER_ID
  let token = DEFAULT_TOKEN
  let defaultModel: string | undefined
  let configPath = defaults.configPath

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
    else throw new Error(`unknown flag: ${arg}`)
  }

  return { sub, baseUrl, providerId, token, defaultModel, configPath }
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

function viberelayProviderBlock(args: ParsedArgs) {
  const baseUrl = args.baseUrl.endsWith('/v1')
    ? args.baseUrl
    : `${args.baseUrl.replace(/\/$/, '')}/v1`
  return {
    baseUrl,
    apiKey: args.token,
    models: {
      'claude-sonnet-4-5': {},
      'claude-opus-4-5': {},
      'claude-haiku-4-5': {},
      'openai/gpt-5.4-reasoning-high': {},
      'openai/gpt-5.4-reasoning-low': {},
      'openai/gpt-5.4-mini': {},
      high: {},
      mid: {},
      low: {}
    }
  }
}

function mergeConfig(existing: OpenClawConfig, args: ParsedArgs): OpenClawConfig {
  const merged: OpenClawConfig = { ...existing }
  const models = { ...(merged.models ?? {}) }
  const providers = { ...(models.providers ?? {}) }
  providers[args.providerId] = viberelayProviderBlock(args)
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
    const block = { models: { providers: { [args.providerId]: viberelayProviderBlock(args) } } }
    return JSON.stringify(block, null, 2)
  }

  const existing = await loadExistingConfig(args.configPath)

  if (args.sub === 'status') {
    const provider = existing.models?.providers?.[args.providerId]
    if (!provider) return `openclaw is NOT wired at ${args.configPath} (no provider \`${args.providerId}\`)`
    const lines = [
      `openclaw is wired at ${args.configPath}`,
      `  provider: ${args.providerId}`,
      `  baseUrl:  ${provider.baseUrl ?? '(missing)'}`,
      `  apiKey:   ${provider.apiKey ? '(set)' : '(missing)'}`,
      `  models:   ${Object.keys(provider.models ?? {}).length} configured`
    ]
    if (existing.agent?.model) lines.push(`  agent.model: ${existing.agent.model}`)
    return lines.join('\n')
  }

  // setup
  await mkdir(dirname(args.configPath), { recursive: true })
  try {
    await copyFile(args.configPath, `${args.configPath}.${Date.now()}.bak`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const merged = mergeConfig(existing, args)
  await writeFile(args.configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

  const lines = [
    `✓ wrote ${args.configPath}`,
    `  provider \`${args.providerId}\` → ${viberelayProviderBlock(args).baseUrl}`
  ]
  if (args.defaultModel) lines.push(`  agent.model = ${args.providerId}/${args.defaultModel}`)
  lines.push(`  next: start viberelay (\`viberelay start\`) and run openclaw — pick a \`${args.providerId}/...\` model.`)
  return lines.join('\n')
}
