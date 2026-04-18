import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createInterface, type Interface } from 'node:readline'

export interface ProfileEnv {
  [key: string]: string
}

export interface ProfileFile {
  env: ProfileEnv
  account?: string
}

export interface SelectChoice {
  label: string
  value: string
  hint?: string
}

export interface Prompter {
  text(options: { message: string, default?: string, validate?: (value: string) => string | true }): Promise<string>
  select(options: { message: string, choices: SelectChoice[], defaultValue?: string }): Promise<string>
  confirm(options: { message: string, default?: boolean }): Promise<boolean>
}

export interface ProfileCommandOptions {
  baseUrl: string
  profilesDir?: string
  argv?: string[]
  spawnClaude?: (env: NodeJS.ProcessEnv, args: string[], dangerous: boolean) => Promise<number>
  spawnEditor?: (editor: string, file: string) => Promise<number>
  prompter?: Prompter
  stdout?: NodeJS.WritableStream
}

interface CreateOptions {
  name: string
  baseUrl: string
  token: string
  opus?: string
  sonnet?: string
  haiku?: string
  defaultModel?: string
  subagentModel?: string
  account?: string
  force: boolean
}

interface ModelGroupEntry { id: string, name: string, models: string[], enabled: boolean }

const DEFAULT_TOKEN = 'viberelay-local'

export function resolveProfilesDir(override?: string): string {
  return override ?? process.env.VIBERELAY_PROFILES_DIR ?? join(homedir(), '.viberelay', 'profiles')
}

export async function runProfileCommand(options: ProfileCommandOptions): Promise<string> {
  const argv = options.argv ?? process.argv.slice(3)
  const sub = argv[0]
  const rest = argv.slice(1)
  const profilesDir = resolveProfilesDir(options.profilesDir)

  switch (sub) {
    case undefined:
    case 'list':
    case 'ls':
      return formatList(await listProfiles(profilesDir), profilesDir)
    case 'show':
    case 'cat':
      return showProfile(profilesDir, requireName(rest[0], 'show'))
    case 'delete':
    case 'rm':
      return deleteProfile(profilesDir, requireName(rest[0], 'delete'))
    case 'create':
      return createProfileCommand(profilesDir, rest, options)
    case 'edit':
      return editProfile(profilesDir, requireName(rest[0], 'edit'), options.spawnEditor)
    case 'set':
      return setProfileFields(profilesDir, rest)
    case 'path':
      return profilePath(profilesDir, requireName(rest[0], 'path'))
    case 'run':
      return runProfile(profilesDir, rest, options.spawnClaude)
    case 'help':
    case '--help':
    case '-h':
      return profileUsage()
    default:
      throw new Error(`Unknown profile subcommand: ${sub}\n${profileUsage()}`)
  }
}

function profileUsage(): string {
  return [
    'Usage: viberelay profile <subcommand>',
    '',
    'Subcommands:',
    '  list                      List profiles',
    '  show <name>               Print profile JSON',
    '  path <name>               Print profile file path',
    '  create [name] [flags]     Create a viberelay-linked profile (interactive by default)',
    '  edit <name>               Open profile in $EDITOR (validates JSON on save)',
    '  set <name> [flags]        Patch fields in an existing profile',
    '  delete <name>             Remove a profile',
    '  run [--dangerous] <name> [claude args...]  Launch claude with profile env',
    '',
    'create flags (skip any prompt by passing the value):',
    '  --opus <group>            Model group alias for opus',
    '  --sonnet <group>          Model group alias for sonnet',
    '  --haiku <group>           Model group alias for haiku',
    '  --default-model <model>   ANTHROPIC_MODEL (default: opus alias)',
    '  --subagent-model <model>  CLAUDE_CODE_SUBAGENT_MODEL (default: haiku alias)',
    '  --base-url <url>          Override ANTHROPIC_BASE_URL',
    '  --token <token>           ANTHROPIC_AUTH_TOKEN (default: viberelay-local)',
    '  --account <account>       CLP-compatible account name for isolation',
    '  --force                   Overwrite existing profile',
    '  --no-interactive          Fail instead of prompting for missing values',
    ''
  ].join('\n')
}

function requireName(value: string | undefined, action: string): string {
  if (!value) {
    throw new Error(`profile ${action}: missing profile name`)
  }
  return value
}

export async function listProfiles(profilesDir: string): Promise<string[]> {
  try {
    const entries = await readdir(profilesDir)
    return entries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -'.json'.length)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function formatList(profiles: string[], profilesDir: string): string {
  if (profiles.length === 0) {
    return `No profiles in ${profilesDir}`
  }
  return profiles.map((name) => `- ${name}`).join('\n')
}

async function showProfile(profilesDir: string, name: string): Promise<string> {
  const profile = await readProfile(profilesDir, name)
  return JSON.stringify(profile, null, 2)
}

async function deleteProfile(profilesDir: string, name: string): Promise<string> {
  const file = profilePath(profilesDir, name)
  await rm(file, { force: false })
  return `Deleted profile ${name}`
}

export async function readProfile(profilesDir: string, name: string): Promise<ProfileFile> {
  const file = profilePath(profilesDir, name)
  const raw = await readFile(file, 'utf8')
  return JSON.parse(raw) as ProfileFile
}

function profilePath(profilesDir: string, name: string): string {
  const filename = name.endsWith('.json') ? name : `${name}.json`
  return join(profilesDir, filename)
}

async function createProfileCommand(
  profilesDir: string,
  args: string[],
  options: ProfileCommandOptions
): Promise<string> {
  const { positional, flags } = parseCreateArgs(args)
  const baseUrl = flags.baseUrl ?? options.baseUrl
  const groups = await fetchModelGroups(baseUrl)
  const groupNames = groups.map((group) => group.name)
  const existingProfiles = new Set(await listProfiles(profilesDir))

  const interactive = flags.interactive && (options.prompter !== undefined || process.stdin.isTTY === true)
  const prompter = options.prompter ?? (interactive ? new ReadlinePrompter() : null)

  const resolved = await resolveFromFlags({
    groupNames,
    positional,
    flags,
    existingProfiles,
    prompter,
    interactive
  })

  const opts: CreateOptions = {
    name: resolved.name,
    baseUrl,
    token: resolved.token,
    opus: resolved.opus,
    sonnet: resolved.sonnet,
    haiku: resolved.haiku,
    defaultModel: resolved.defaultModel,
    subagentModel: resolved.subagentModel,
    account: resolved.account,
    force: resolved.force
  }

  const profile = buildProfile(opts)
  await writeProfile(profilesDir, opts.name, profile, opts.force)

  const availableNote = groups.length === 0 ? ' (no model groups available yet; edit the profile once you add some)' : ''
  return [
    `Created profile ${opts.name} at ${profilePath(profilesDir, opts.name)}${availableNote}`,
    `  base_url=${opts.baseUrl}`,
    `  opus=${opts.opus ?? '(unset)'}`,
    `  sonnet=${opts.sonnet ?? '(unset)'}`,
    `  haiku=${opts.haiku ?? '(unset)'}`,
    `  default_model=${opts.defaultModel ?? '(unset)'}`,
    `  subagent_model=${opts.subagentModel ?? '(unset)'}`
  ].join('\n')
}

interface ParsedFlags {
  baseUrl?: string
  token?: string
  opus?: string
  sonnet?: string
  haiku?: string
  defaultModel?: string
  subagentModel?: string
  account?: string
  force: boolean
  interactive: boolean
}

function parseCreateArgs(args: string[]): { positional: string[], flags: ParsedFlags } {
  const flags: ParsedFlags = { force: false, interactive: true }
  const positional: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i]
    const next = (): string => {
      const value = args[i + 1]
      if (value === undefined) {
        throw new Error(`profile create: flag ${key} requires a value`)
      }
      i += 1
      return value
    }
    switch (key) {
      case '--opus': flags.opus = next(); break
      case '--sonnet': flags.sonnet = next(); break
      case '--haiku': flags.haiku = next(); break
      case '--default-model': flags.defaultModel = next(); break
      case '--subagent-model': flags.subagentModel = next(); break
      case '--base-url': flags.baseUrl = next(); break
      case '--token': flags.token = next(); break
      case '--account': flags.account = next(); break
      case '--force': flags.force = true; break
      case '--no-interactive': flags.interactive = false; break
      case '--interactive': flags.interactive = true; break
      default:
        if (key.startsWith('--')) {
          throw new Error(`profile create: unknown flag ${key}`)
        }
        positional.push(key)
    }
  }
  return { positional, flags }
}

interface ResolvedCreate {
  name: string
  baseUrl: string
  token: string
  opus?: string
  sonnet?: string
  haiku?: string
  defaultModel?: string
  subagentModel?: string
  account?: string
  force: boolean
}

async function resolveFromFlags(context: {
  groupNames: string[]
  positional: string[]
  flags: ParsedFlags
  existingProfiles: Set<string>
  prompter: Prompter | null
  interactive: boolean
}): Promise<ResolvedCreate> {
  const { groupNames, positional, flags, existingProfiles, prompter, interactive } = context
  const autoPick = autoPickAliases(groupNames)

  const name = await resolveName(positional[0], existingProfiles, prompter, interactive, flags.force)
  const force = flags.force || (existingProfiles.has(name) && !!prompter && (await prompter.confirm({ message: `Profile ${name} exists. Overwrite?`, default: false })))
  if (existingProfiles.has(name) && !force) {
    throw new Error(`profile create: ${name} already exists (use --force to overwrite)`)
  }

  const opus = await resolveGroup('opus', flags.opus, autoPick.opus, groupNames, prompter, interactive)
  const sonnet = await resolveGroup('sonnet', flags.sonnet, autoPick.sonnet ?? opus, groupNames, prompter, interactive)
  const haiku = await resolveGroup('haiku', flags.haiku, autoPick.haiku ?? sonnet ?? opus, groupNames, prompter, interactive)

  const defaultModel = flags.defaultModel ?? opus
  const subagentModel = flags.subagentModel ?? haiku

  return {
    name,
    baseUrl: flags.baseUrl ?? '',
    token: flags.token ?? DEFAULT_TOKEN,
    opus,
    sonnet,
    haiku,
    defaultModel,
    subagentModel,
    account: flags.account,
    force
  }
}

async function resolveName(
  provided: string | undefined,
  existing: Set<string>,
  prompter: Prompter | null,
  interactive: boolean,
  force: boolean
): Promise<string> {
  if (provided) return provided
  if (!interactive || !prompter) {
    throw new Error('profile create: missing profile name (pass it as an argument or run interactively)')
  }
  return prompter.text({
    message: 'Profile name',
    default: suggestProfileName(existing),
    validate: (value) => {
      const trimmed = value.trim()
      if (!trimmed) return 'Name cannot be empty'
      if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return 'Use letters, numbers, dot, dash, underscore'
      if (!force && existing.has(trimmed)) return `Profile ${trimmed} already exists`
      return true
    }
  })
}

function suggestProfileName(existing: Set<string>): string {
  const base = 'viberelay'
  if (!existing.has(base)) return base
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`
    if (!existing.has(candidate)) return candidate
  }
  return base
}

async function resolveGroup(
  alias: 'opus' | 'sonnet' | 'haiku',
  flagValue: string | undefined,
  suggestion: string | undefined,
  groupNames: string[],
  prompter: Prompter | null,
  interactive: boolean
): Promise<string | undefined> {
  if (flagValue) return flagValue
  if (groupNames.length === 0) return suggestion
  if (!interactive || !prompter) return suggestion

  const choices: SelectChoice[] = groupNames.map((name) => ({ label: name, value: name }))
  choices.push({ label: '(skip — leave unset)', value: '', hint: 'no override for this alias' })

  const defaultValue = suggestion && groupNames.includes(suggestion) ? suggestion : choices[0]!.value
  const picked = await prompter.select({
    message: `Pick model group for ${alias}`,
    choices,
    defaultValue
  })
  return picked === '' ? undefined : picked
}

async function fetchModelGroups(baseUrl: string): Promise<ModelGroupEntry[]> {
  try {
    const response = await fetch(`${baseUrl}/relay/settings-state`)
    if (!response.ok) return []
    const payload = await response.json() as { modelGroups?: ModelGroupEntry[] }
    return (payload.modelGroups ?? []).filter((group) => group.enabled && group.models.length > 0)
  } catch {
    return []
  }
}

function autoPickAliases(names: string[]): { opus?: string, sonnet?: string, haiku?: string } {
  const pick = (hint: string): string | undefined => {
    const lower = hint.toLowerCase()
    return names.find((name) => name.toLowerCase().includes(lower))
  }
  const first = names[0]
  return {
    opus: pick('opus') ?? first,
    sonnet: pick('sonnet') ?? pick('opus') ?? first,
    haiku: pick('haiku') ?? pick('sonnet') ?? first
  }
}

function buildProfile(opts: CreateOptions): ProfileFile {
  const env: ProfileEnv = {
    ANTHROPIC_BASE_URL: opts.baseUrl,
    ANTHROPIC_AUTH_TOKEN: opts.token
  }
  if (opts.defaultModel) env.ANTHROPIC_MODEL = opts.defaultModel
  if (opts.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opts.opus
  if (opts.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = opts.sonnet
  if (opts.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = opts.haiku
  if (opts.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = opts.subagentModel
  const profile: ProfileFile = { env }
  if (opts.account) profile.account = opts.account
  return profile
}

async function writeProfile(profilesDir: string, name: string, profile: ProfileFile, force: boolean): Promise<void> {
  const file = profilePath(profilesDir, name)
  await mkdir(dirname(file), { recursive: true })
  if (!force) {
    try {
      await readFile(file, 'utf8')
      throw new Error(`profile create: ${name} already exists (use --force to overwrite)`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }
  await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
}

async function runProfile(
  profilesDir: string,
  args: string[],
  spawnClaude?: ProfileCommandOptions['spawnClaude']
): Promise<string> {
  let dangerous = false
  let idx = 0
  while (idx < args.length) {
    const flag = args[idx]
    if (flag === '-d' || flag === '--dangerous' || flag === '--dangerously-skip-permissions') {
      dangerous = true
      idx += 1
      continue
    }
    break
  }
  const name = requireName(args[idx], 'run')
  const claudeArgs = args.slice(idx + 1)
  const profile = await readProfile(profilesDir, name)
  const env: NodeJS.ProcessEnv = { ...process.env, ...profile.env }
  if (profile.account) {
    env.CLP_ACCOUNT = profile.account
    env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude-accounts', profile.account)
  }
  const runner = spawnClaude ?? defaultSpawnClaude
  const code = await runner(env, claudeArgs, dangerous)
  if (code !== 0) {
    throw new Error(`claude exited with code ${code}`)
  }
  return `profile ${name} session ended`
}

async function editProfile(
  profilesDir: string,
  name: string,
  spawnEditor?: ProfileCommandOptions['spawnEditor']
): Promise<string> {
  const file = profilePath(profilesDir, name)
  await readFile(file, 'utf8')
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi'
  const runner = spawnEditor ?? defaultSpawnEditor
  const code = await runner(editor, file)
  if (code !== 0) {
    throw new Error(`editor exited with code ${code}`)
  }
  const raw = await readFile(file, 'utf8')
  try {
    JSON.parse(raw)
  } catch (error) {
    throw new Error(`profile ${name} contains invalid JSON after edit: ${(error as Error).message}`)
  }
  return `Edited profile ${name} (${file})`
}

async function setProfileFields(profilesDir: string, args: string[]): Promise<string> {
  const name = requireName(args[0], 'set')
  const { flags } = parseCreateArgs(args.slice(1))
  const profile = await readProfile(profilesDir, name)

  const changes: string[] = []
  const apply = (key: string, value: string | undefined, envKey: string): void => {
    if (value === undefined) return
    profile.env[envKey] = value
    changes.push(`${key}=${value}`)
  }

  apply('base_url', flags.baseUrl, 'ANTHROPIC_BASE_URL')
  apply('token', flags.token, 'ANTHROPIC_AUTH_TOKEN')
  apply('opus', flags.opus, 'ANTHROPIC_DEFAULT_OPUS_MODEL')
  apply('sonnet', flags.sonnet, 'ANTHROPIC_DEFAULT_SONNET_MODEL')
  apply('haiku', flags.haiku, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')
  apply('default_model', flags.defaultModel, 'ANTHROPIC_MODEL')
  apply('subagent_model', flags.subagentModel, 'CLAUDE_CODE_SUBAGENT_MODEL')

  if (flags.account !== undefined) {
    profile.account = flags.account
    changes.push(`account=${flags.account}`)
  }

  if (changes.length === 0) {
    throw new Error('profile set: no fields provided (use --opus, --sonnet, --haiku, --base-url, --token, --default-model, --subagent-model, --account)')
  }

  const file = profilePath(profilesDir, name)
  await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  return `Updated profile ${name} (${changes.join(', ')})`
}

function defaultSpawnEditor(editor: string, file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [file], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 0))
  })
}

function defaultSpawnClaude(env: NodeJS.ProcessEnv, args: string[], dangerous: boolean): Promise<number> {
  const finalArgs = dangerous ? ['--dangerously-skip-permissions', ...args] : args
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', finalArgs, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) => resolvePromise(code ?? 0))
  })
}

class ReadlinePrompter implements Prompter {
  async text(options: { message: string, default?: string, validate?: (value: string) => string | true }): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      while (true) {
        const answer = await askLine(rl, formatTextPrompt(options.message, options.default))
        const value = answer.trim() === '' && options.default !== undefined ? options.default : answer
        const validation = options.validate ? options.validate(value) : true
        if (validation === true) return value
        process.stderr.write(`  ✗ ${validation}\n`)
      }
    } finally {
      rl.close()
    }
  }

  async confirm(options: { message: string, default?: boolean }): Promise<boolean> {
    const hint = options.default ? 'Y/n' : 'y/N'
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = (await askLine(rl, `? ${options.message} (${hint}) `)).trim().toLowerCase()
      if (!answer) return options.default ?? false
      return answer === 'y' || answer === 'yes'
    } finally {
      rl.close()
    }
  }

  async select(options: { message: string, choices: SelectChoice[], defaultValue?: string }): Promise<string> {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      return selectNumbered(options)
    }
    return selectInteractive(options)
  }
}

function formatTextPrompt(message: string, defaultValue?: string): string {
  return defaultValue ? `? ${message} (${defaultValue}) ` : `? ${message} `
}

function askLine(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)))
}

async function selectNumbered(options: { message: string, choices: SelectChoice[], defaultValue?: string }): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const defaultIndex = Math.max(0, options.choices.findIndex((choice) => choice.value === options.defaultValue))
    process.stderr.write(`? ${options.message}\n`)
    options.choices.forEach((choice, index) => {
      const marker = index === defaultIndex ? '*' : ' '
      const hint = choice.hint ? ` — ${choice.hint}` : ''
      process.stderr.write(`  ${marker} ${index + 1}) ${choice.label}${hint}\n`)
    })
    while (true) {
      const answer = (await askLine(rl, `  Pick [1-${options.choices.length}] (${defaultIndex + 1}) `)).trim()
      const pickIndex = answer === '' ? defaultIndex : Number.parseInt(answer, 10) - 1
      if (Number.isInteger(pickIndex) && pickIndex >= 0 && pickIndex < options.choices.length) {
        return options.choices[pickIndex]!.value
      }
      process.stderr.write('  ✗ invalid choice\n')
    }
  } finally {
    rl.close()
  }
}

async function selectInteractive(options: { message: string, choices: SelectChoice[], defaultValue?: string }): Promise<string> {
  const { stdin, stderr } = process
  let index = Math.max(0, options.choices.findIndex((choice) => choice.value === options.defaultValue))
  if (index < 0) index = 0

  stderr.write(`? ${options.message} (↑/↓ to move, enter to select)\n`)
  renderChoices(options.choices, index)

  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  try {
    while (true) {
      const key: string = await new Promise((resolve) => stdin.once('data', (data: string | Buffer) => resolve(typeof data === 'string' ? data : data.toString('utf8'))))
      if (key === '\u0003') {
        throw new Error('cancelled by user')
      }
      if (key === '\r' || key === '\n') {
        clearChoices(options.choices.length)
        const selected = options.choices[index]!
        stderr.write(`  ✓ ${selected.label}\n`)
        return selected.value
      }
      if (key === '\u001b[A' || key === 'k') {
        index = (index - 1 + options.choices.length) % options.choices.length
      } else if (key === '\u001b[B' || key === 'j') {
        index = (index + 1) % options.choices.length
      } else {
        continue
      }
      clearChoices(options.choices.length)
      renderChoices(options.choices, index)
    }
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
  }
}

function renderChoices(choices: SelectChoice[], activeIndex: number): void {
  for (let i = 0; i < choices.length; i += 1) {
    const choice = choices[i]!
    const pointer = i === activeIndex ? '▶' : ' '
    const hint = choice.hint ? ` — ${choice.hint}` : ''
    const line = `${pointer} ${choice.label}${hint}`
    process.stderr.write(i === activeIndex ? `\u001b[36m${line}\u001b[0m\n` : `${line}\n`)
  }
}

function clearChoices(count: number): void {
  for (let i = 0; i < count; i += 1) {
    process.stderr.write('\u001b[1A\u001b[2K')
  }
}
