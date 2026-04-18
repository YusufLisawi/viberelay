import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonController } from '../../daemon/src/index.js'
import { listProfiles, readProfile, runProfileCommand, type Prompter, type SelectChoice } from '../src/commands/profile.js'

function scriptedPrompter(script: {
  textAnswers?: string[]
  selectAnswers?: Record<string, string>
  confirmAnswers?: boolean[]
  log?: Array<{ kind: string, message: string, choices?: string[] }>
}): Prompter {
  const texts = [...(script.textAnswers ?? [])]
  const confirms = [...(script.confirmAnswers ?? [])]
  const log = script.log
  return {
    async text(options) {
      log?.push({ kind: 'text', message: options.message })
      const answer = texts.shift() ?? options.default ?? ''
      const validation = options.validate ? options.validate(answer) : true
      if (validation !== true) throw new Error(`validate failed: ${validation}`)
      return answer
    },
    async select(options) {
      log?.push({ kind: 'select', message: options.message, choices: options.choices.map((c: SelectChoice) => c.value) })
      if (script.selectAnswers && options.message in script.selectAnswers) {
        return script.selectAnswers[options.message]!
      }
      const match = Object.keys(script.selectAnswers ?? {}).find((key) => options.message.toLowerCase().includes(key.toLowerCase()))
      if (match) return script.selectAnswers![match]!
      return options.defaultValue ?? options.choices[0]!.value
    },
    async confirm(options) {
      log?.push({ kind: 'confirm', message: options.message })
      return confirms.shift() ?? options.default ?? false
    }
  }
}

const controllers: ReturnType<typeof createDaemonController>[] = []
const tempDirs: string[] = []

afterEach(async () => {
  while (controllers.length > 0) {
    const controller = controllers.pop()
    if (controller) await controller.stop()
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function bootDaemon() {
  const authDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profile-auth-'))
  tempDirs.push(authDir)
  const controller = createDaemonController({ port: 0, authDir })
  controllers.push(controller)
  const started = await controller.start()
  return { controller, baseUrl: `http://${started.host}:${started.port}` }
}

describe('profile command', () => {
  it('lists empty profiles directory', async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profiles-'))
    tempDirs.push(profilesDir)

    const output = await runProfileCommand({ baseUrl: 'http://127.0.0.1:0', profilesDir, argv: ['list'] })

    expect(output).toContain('No profiles')
    expect(await listProfiles(profilesDir)).toEqual([])
  })

  it('creates a viberelay-linked profile with model aliases', async () => {
    const { baseUrl } = await bootDaemon()
    const profilesDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profiles-'))
    tempDirs.push(profilesDir)

    const output = await runProfileCommand({
      baseUrl,
      profilesDir,
      argv: ['create', 'vibe-local', '--opus', 'opus-high', '--sonnet', 'sonnet-high', '--haiku', 'haiku-low']
    })

    expect(output).toContain('Created profile vibe-local')
    const profile = await readProfile(profilesDir, 'vibe-local')
    expect(profile.env.ANTHROPIC_BASE_URL).toBe(baseUrl)
    expect(profile.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus-high')
    expect(profile.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-high')
    expect(profile.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku-low')
    expect(profile.env.ANTHROPIC_MODEL).toBe('opus-high')
    expect(profile.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('haiku-low')
    expect(profile.env.ANTHROPIC_AUTH_TOKEN).toBe('viberelay-local')

    const list = await runProfileCommand({ baseUrl, profilesDir, argv: ['list'] })
    expect(list).toContain('vibe-local')
  })

  it('refuses to overwrite without --force and deletes profiles', async () => {
    const { baseUrl } = await bootDaemon()
    const profilesDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profiles-'))
    tempDirs.push(profilesDir)

    await runProfileCommand({ baseUrl, profilesDir, argv: ['create', 'dup', '--opus', 'g'] })
    await expect(runProfileCommand({ baseUrl, profilesDir, argv: ['create', 'dup', '--opus', 'g'] }))
      .rejects.toThrow(/already exists/)

    const force = await runProfileCommand({ baseUrl, profilesDir, argv: ['create', 'dup', '--opus', 'g2', '--force'] })
    expect(force).toContain('Created profile dup')
    expect((await readProfile(profilesDir, 'dup')).env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('g2')

    await runProfileCommand({ baseUrl, profilesDir, argv: ['delete', 'dup'] })
    expect(await listProfiles(profilesDir)).toEqual([])
  })

  it('run exports profile env and invokes spawnClaude', async () => {
    const { baseUrl } = await bootDaemon()
    const profilesDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profiles-'))
    tempDirs.push(profilesDir)

    await runProfileCommand({
      baseUrl,
      profilesDir,
      argv: ['create', 'session', '--opus', 'opus-g', '--haiku', 'haiku-g', '--account', 'team-a']
    })

    let capturedEnv: NodeJS.ProcessEnv = {}
    let capturedArgs: string[] = []
    let capturedDangerous = false
    await runProfileCommand({
      baseUrl,
      profilesDir,
      argv: ['run', '--dangerous', 'session', '--continue'],
      spawnClaude: async (env, args, dangerous) => {
        capturedEnv = env
        capturedArgs = args
        capturedDangerous = dangerous
        return 0
      }
    })

    expect(capturedDangerous).toBe(true)
    expect(capturedArgs).toEqual(['--continue'])
    expect(capturedEnv.ANTHROPIC_BASE_URL).toBe(baseUrl)
    expect(capturedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus-g')
    expect(capturedEnv.CLP_ACCOUNT).toBe('team-a')
    expect(capturedEnv.CLAUDE_CONFIG_DIR).toContain('team-a')
  })

  it('interactive wizard selects name and per-alias groups', async () => {
    const { baseUrl } = await bootDaemon()
    for (const name of ['opus-high', 'sonnet-balanced', 'haiku-fast']) {
      await fetch(`${baseUrl}/relay/model-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: name, name, models: [`${name}-model`], enabled: true })
      })
    }

    const profilesDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profiles-'))
    tempDirs.push(profilesDir)

    const log: Array<{ kind: string, message: string, choices?: string[] }> = []
    const prompter = scriptedPrompter({
      textAnswers: ['work-vibe'],
      selectAnswers: {
        'opus': 'opus-high',
        'sonnet': 'sonnet-balanced',
        'haiku': 'haiku-fast'
      },
      log
    })

    const output = await runProfileCommand({ baseUrl, profilesDir, argv: ['create'], prompter })
    expect(output).toContain('Created profile work-vibe')

    const profile = await readProfile(profilesDir, 'work-vibe')
    expect(profile.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus-high')
    expect(profile.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-balanced')
    expect(profile.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku-fast')
    expect(profile.env.ANTHROPIC_MODEL).toBe('opus-high')
    expect(profile.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('haiku-fast')

    expect(log.map((entry) => entry.kind)).toEqual(['text', 'select', 'select', 'select'])
    const opusEntry = log.find((entry) => entry.kind === 'select' && entry.message.includes('opus'))
    expect(opusEntry?.choices).toContain('opus-high')
    expect(opusEntry?.choices).toContain('')
  })

  it('set patches specific fields without rewriting others', async () => {
    const { baseUrl } = await bootDaemon()
    const profilesDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profiles-'))
    tempDirs.push(profilesDir)
    await runProfileCommand({ baseUrl, profilesDir, argv: ['create', 'tweak', '--opus', 'o1', '--sonnet', 's1', '--haiku', 'h1', '--account', 'acct1'] })

    const output = await runProfileCommand({
      baseUrl,
      profilesDir,
      argv: ['set', 'tweak', '--sonnet', 's2', '--default-model', 'o1', '--account', 'acct2']
    })
    expect(output).toContain('sonnet=s2')

    const profile = await readProfile(profilesDir, 'tweak')
    expect(profile.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('s2')
    expect(profile.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('o1')
    expect(profile.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('h1')
    expect(profile.env.ANTHROPIC_MODEL).toBe('o1')
    expect(profile.account).toBe('acct2')

    await expect(runProfileCommand({ baseUrl, profilesDir, argv: ['set', 'tweak'] }))
      .rejects.toThrow(/no fields provided/)
  })

  it('edit launches $EDITOR and re-validates JSON', async () => {
    const { baseUrl } = await bootDaemon()
    const profilesDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profiles-'))
    tempDirs.push(profilesDir)
    await runProfileCommand({ baseUrl, profilesDir, argv: ['create', 'editable', '--opus', 'o'] })

    let capturedEditor = ''
    let capturedFile = ''
    const output = await runProfileCommand({
      baseUrl,
      profilesDir,
      argv: ['edit', 'editable'],
      spawnEditor: async (editor, file) => {
        capturedEditor = editor
        capturedFile = file
        return 0
      }
    })
    expect(output).toContain('Edited profile editable')
    expect(capturedEditor.length).toBeGreaterThan(0)
    expect(capturedFile).toContain('editable.json')

    // path subcommand returns the same file
    const pathOut = await runProfileCommand({ baseUrl, profilesDir, argv: ['path', 'editable'] })
    expect(pathOut).toBe(capturedFile)
  })

  it('show prints profile JSON for existing file', async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-profiles-'))
    tempDirs.push(profilesDir)
    const { baseUrl } = await bootDaemon()
    await runProfileCommand({ baseUrl, profilesDir, argv: ['create', 'peek', '--opus', 'o'] })

    const output = await runProfileCommand({ baseUrl, profilesDir, argv: ['show', 'peek'] })
    expect(output).toContain('ANTHROPIC_BASE_URL')
    // Round-trip sanity
    const parsed = JSON.parse(output) as { env: Record<string, string> }
    expect(parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('o')

    const raw = await readFile(join(profilesDir, 'peek.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
  })
})
