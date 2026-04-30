import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { relayMindPaths } from '@viberelay/shared/relaymind'
import {
  _locateBundleForTest,
  ensureProfileLayout,
  installHookStubs,
  installPluginBundle,
  installSkillStubs,
  installTelegramPluginIntoProfile,
  preMarkWorkspaceTrusted,
  profileMarketplacePath,
  relayMindPluginPath,
  telegramPluginPath,
  verifyInstallation,
  writeContextFiles,
  writeDefaultConfig,
  writeDefaultRegistry,
  writeProfileMarketplace,
  writeProfileSettings,
} from '../src/lib/profile-installer.js'
import init from '../src/commands/relaymind/init.js'
import setup from '../src/commands/relaymind/setup.js'
import doctor from '../src/commands/relaymind/doctor.js'
import { captureTelegramPairing } from '../src/lib/profile-installer.js'

let workspace: string
let originalCwd: string

beforeEach(async () => {
  originalCwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-installer-'))
  process.chdir(workspace)
  // Redirect Claude Code's user-level config to a per-test sandbox so the
  // trust pre-mark can't mutate the developer's real ~/.claude.json.
  process.env.RELAYMIND_CLAUDE_CONFIG_PATH = join(workspace, '.claude.json')
})

afterEach(async () => {
  process.chdir(originalCwd)
  delete process.env.RELAYMIND_CLAUDE_CONFIG_PATH
  await rm(workspace, { recursive: true, force: true })
})

async function runFullSetup(): Promise<ReturnType<typeof relayMindPaths>> {
  const paths = relayMindPaths(workspace)
  await ensureProfileLayout(paths)
  await installPluginBundle(paths)
  await writeContextFiles(paths)
  await writeDefaultRegistry(paths)
  await writeDefaultConfig(paths)
  await writeProfileSettings(paths)
  await writeProfileMarketplace(paths)
  await installTelegramPluginIntoProfile(paths)
  // Deprecated stubs — exercised to confirm they are no-ops.
  await installSkillStubs(paths)
  await installHookStubs(paths)
  return paths
}

describe('profile-installer', () => {
  it('lays down the full profile and verifyInstallation passes', async () => {
    const paths = await runFullSetup()
    const v = await verifyInstallation(paths)
    expect(v.issues).toEqual([])
    expect(v.ok).toBe(true)
  })

  it('is idempotent — second run preserves user edits to context, registry, settings env', async () => {
    const paths = await runFullSetup()

    const userSoul = '# my custom soul\n'
    await writeFile(paths.soulMd, userSoul, 'utf8')
    const userRegistry = JSON.stringify({ commands: [{ name: 'mine', description: 'x', mode: 'direct', handler: 'mine' }] }, null, 2)
    await writeFile(paths.registryJson, userRegistry, 'utf8')

    // User adds a custom env key to settings.json that we must preserve.
    const settingsPath = join(paths.claudeProjectDir, 'settings.json')
    const existing = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    const withUser = { ...existing, env: { ...(existing.env as Record<string, string>), USER_KEY: 'keep-me' } }
    await writeFile(settingsPath, JSON.stringify(withUser, null, 2), 'utf8')

    // Second pass.
    await ensureProfileLayout(paths)
    await installPluginBundle(paths)
    await writeContextFiles(paths)
    await writeDefaultRegistry(paths)
    await writeDefaultConfig(paths)
    await writeProfileSettings(paths)
    await installTelegramPluginIntoProfile(paths)

    expect(await readFile(paths.soulMd, 'utf8')).toBe(userSoul)
    expect(await readFile(paths.registryJson, 'utf8')).toBe(userRegistry)
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { env?: Record<string, string> }
    expect(settings.env?.USER_KEY).toBe('keep-me')
  })

  it('force=true overwrites context files', async () => {
    const paths = await runFullSetup()
    await writeFile(paths.soulMd, 'old\n', 'utf8')
    await writeContextFiles(paths, { force: true })
    expect(await readFile(paths.soulMd, 'utf8')).not.toBe('old\n')
  })

  it('verifyInstallation reports issues when a required file is removed', async () => {
    const paths = await runFullSetup()
    await rm(paths.memoryMd)
    const v = await verifyInstallation(paths)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.includes('MEMORY.md'))).toBe(true)
  })

  it('verifyInstallation flags malformed registry.json', async () => {
    const paths = await runFullSetup()
    await writeFile(paths.registryJson, '{ not json', 'utf8')
    const v = await verifyInstallation(paths)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.includes('registry.json'))).toBe(true)
  })

  it('verifyInstallation FAILs when the plugin bundle dir is removed', async () => {
    const paths = await runFullSetup()
    await rm(relayMindPluginPath(paths), { recursive: true, force: true })
    const v = await verifyInstallation(paths)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.includes('plugin bundle: missing'))).toBe(true)
  })

  it('plugin bundle is copied into <profile>/.claude/plugins/relaymind/', async () => {
    const paths = await runFullSetup()
    const pluginDir = relayMindPluginPath(paths)
    const sessionStartHook = join(pluginDir, 'hooks', 'session-start.sh')
    const s = await stat(sessionStartHook)
    expect(s.isFile()).toBe(true)
    const content = await readFile(sessionStartHook, 'utf8')
    expect(content).toContain('viberelay relaymind context render')

    // All five skills present.
    for (const slug of ['relaymind-memory', 'relaymind-checkpoint', 'relaymind-daily', 'relaymind-self-heal', 'relaymind-commands']) {
      const f = join(pluginDir, 'skills', slug, 'SKILL.md')
      expect((await stat(f)).isFile()).toBe(true)
    }
  })

  it('writeProfileMarketplace lays down a marketplace.json declaring both bundled plugins', async () => {
    const paths = await runFullSetup()
    const target = profileMarketplacePath(paths)
    const parsed = JSON.parse(await readFile(target, 'utf8')) as {
      name: string
      owner: { name: string }
      plugins: Array<{ name: string; source: string }>
    }
    expect(parsed.name).toBe('vibemind-local')
    expect(parsed.owner.name).toBe('RelayMind')
    expect(parsed.plugins).toEqual([
      { name: 'vibemind-relaymind', source: './.claude/plugins/relaymind' },
      { name: 'vibemind-telegram', source: './.claude/plugins/vibemind-telegram' },
    ])

    // Idempotent: a second call with identical content returns false.
    expect(await writeProfileMarketplace(paths)).toBe(false)
  })

  it('settings.json permissions.allow lists both plugin channel selectors', async () => {
    const paths = await runFullSetup()
    const settings = JSON.parse(await readFile(join(paths.claudeProjectDir, 'settings.json'), 'utf8')) as {
      permissions?: { allow?: string[] }
    }
    const allow = settings.permissions?.allow ?? []
    expect(allow).toContain('Plugin:vibemind-telegram@vibemind-local')
    expect(allow).toContain('Plugin:vibemind-relaymind@vibemind-local')
  })

  it('preMarkWorkspaceTrusted writes hasTrustDialogAccepted=true for the profile cwd', async () => {
    const paths = relayMindPaths(workspace)
    await ensureProfileLayout(paths)
    const fakeHome = join(workspace, 'fake-home')
    const configPath = join(fakeHome, '.claude.json')

    const r1 = await preMarkWorkspaceTrusted(paths, { configPath })
    expect(r1.ok).toBe(true)
    expect(r1.changed).toBe(true)
    const cfg1 = JSON.parse(await readFile(configPath, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
    }
    expect(cfg1.projects?.[paths.claudeHome]?.hasTrustDialogAccepted).toBe(true)

    // Idempotent: second run reports already trusted, no change.
    const r2 = await preMarkWorkspaceTrusted(paths, { configPath })
    expect(r2.ok).toBe(true)
    expect(r2.changed).toBe(false)
  })

  it('preMarkWorkspaceTrusted preserves existing keys in ~/.claude.json', async () => {
    const paths = relayMindPaths(workspace)
    await ensureProfileLayout(paths)
    const fakeHome = join(workspace, 'fake-home')
    const configPath = join(fakeHome, '.claude.json')
    await mkdir(fakeHome, { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        anonymousId: 'keep-me',
        projects: { '/some/other/path': { hasTrustDialogAccepted: true } },
      }),
      'utf8',
    )

    await preMarkWorkspaceTrusted(paths, { configPath })
    const cfg = JSON.parse(await readFile(configPath, 'utf8')) as {
      anonymousId?: string
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
    }
    expect(cfg.anonymousId).toBe('keep-me')
    expect(cfg.projects?.['/some/other/path']?.hasTrustDialogAccepted).toBe(true)
    expect(cfg.projects?.[paths.claudeHome]?.hasTrustDialogAccepted).toBe(true)
  })

  it('settings.json hook commands are absolute paths (no unresolved ${CLAUDE_PLUGIN_ROOT})', async () => {
    const paths = await runFullSetup()
    const settings = await readFile(join(paths.claudeProjectDir, 'settings.json'), 'utf8')
    expect(settings).not.toContain('${CLAUDE_PLUGIN_ROOT}')
    const parsed = JSON.parse(settings) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const sessionStart = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? ''
    expect(sessionStart.startsWith('bash /')).toBe(true)
    expect(sessionStart).toContain(relayMindPluginPath(paths))
  })

  it('CLAUDE.md is wrapped in BEGIN/END markers and a second run preserves user content outside markers', async () => {
    const paths = await runFullSetup()
    const initial = await readFile(paths.claudeMd, 'utf8')
    expect(initial).toContain('<!-- BEGIN RELAYMIND -->')
    expect(initial).toContain('<!-- END RELAYMIND -->')

    // Append user content outside the markers.
    const userTail = '\n\n## User notes\n\nKeep this around.\n'
    await writeFile(paths.claudeMd, initial + userTail, 'utf8')

    // Re-run context write — must replace ONLY the marker block.
    await writeContextFiles(paths, { force: true })
    const after = await readFile(paths.claudeMd, 'utf8')
    expect(after).toContain('## User notes')
    expect(after).toContain('Keep this around.')
    expect(after).toContain('<!-- BEGIN RELAYMIND -->')
  })

  it('CLAUDE.md without markers is preserved when force=false', async () => {
    const paths = relayMindPaths(workspace)
    await ensureProfileLayout(paths)
    await mkdir(paths.claudeHome, { recursive: true })
    const userClaude = '# my own CLAUDE\n\nNo markers here.\n'
    await writeFile(paths.claudeMd, userClaude, 'utf8')
    await writeContextFiles(paths)
    expect(await readFile(paths.claudeMd, 'utf8')).toBe(userClaude)
  })
})

describe('relaymind init/setup/doctor commands', () => {
  it('init writes a checklist and produces a healthy profile', async () => {
    const out = await init([])
    expect(out).toContain('viberelay relaymind init')
    expect(out).toContain('next steps:')
    const v = await verifyInstallation(relayMindPaths(workspace))
    expect(v.ok).toBe(true)
  })

  it('init copies the telegram plugin into the profile by default', async () => {
    await init([])
    const paths = relayMindPaths(workspace)
    const tgDir = telegramPluginPath(paths)
    const pluginJson = join(tgDir, '.claude-plugin', 'plugin.json')
    const s = await stat(pluginJson)
    expect(s.isFile()).toBe(true)
  })

  it('--no-telegram-plugin skips the telegram plugin copy', async () => {
    await init(['--no-telegram-plugin'])
    const paths = relayMindPaths(workspace)
    let exists = true
    try {
      await stat(telegramPluginPath(paths))
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it('setup is idempotent — second run preserves user edits', async () => {
    await init([])
    const paths = relayMindPaths(workspace)
    const userClaude = '# my CLAUDE\n'
    await writeFile(paths.claudeMd, userClaude, 'utf8')
    await setup([])
    expect(await readFile(paths.claudeMd, 'utf8')).toBe(userClaude)
  })

  it('doctor passes after init', async () => {
    await init([])
    const out = await doctor([])
    expect(out).toContain('PASS')
  })

  it('doctor fails when a required file is removed', async () => {
    await init([])
    const paths = relayMindPaths(workspace)
    await rm(paths.toolsMd)
    const out = await doctor([])
    expect(out).toContain('FAIL')
    expect(out).toContain('TOOLS.md')
  })

  it('writeDefaultConfig defaults healthCheckIntervalMs to 60000 and seeds viberelayProfile', async () => {
    await init([])
    const paths = relayMindPaths(workspace)
    const cfg = JSON.parse(await readFile(paths.configJson, 'utf8')) as {
      healthCheckIntervalMs: number
      viberelayProfile: { name: string; opus: string; sonnet: string; haiku: string }
    }
    expect(cfg.healthCheckIntervalMs).toBe(60_000)
    expect(cfg.viberelayProfile).toEqual({
      name: 'relaymind',
      opus: 'high',
      sonnet: 'mid',
      haiku: 'low',
    })
  })

  it('--profile-name / --opus-group overrides land in config.json on first init', async () => {
    await init([
      '--profile-name', 'mybot',
      '--opus-group', 'opus-pool',
      '--sonnet-group', 'sonnet-pool',
      '--haiku-group', 'haiku-pool',
    ])
    const paths = relayMindPaths(workspace)
    const cfg = JSON.parse(await readFile(paths.configJson, 'utf8')) as {
      viberelayProfile: { name: string; opus: string; sonnet: string; haiku: string }
    }
    expect(cfg.viberelayProfile).toEqual({
      name: 'mybot', opus: 'opus-pool', sonnet: 'sonnet-pool', haiku: 'haiku-pool',
    })
  })

  it('captureTelegramPairing dedupes chat ids and only writes env-var name (no secret)', async () => {
    const paths = relayMindPaths(workspace)
    await init([])
    const r1 = await captureTelegramPairing(paths, {
      tokenEnv: 'MY_TOKEN_ENV',
      token: 'super-secret-do-not-leak',
      chatId: '123',
    })
    expect(r1.changed).toBe(true)
    expect(r1.tokenEnv).toBe('MY_TOKEN_ENV')

    // Same chat id again — no change.
    const r2 = await captureTelegramPairing(paths, { chatId: '123' })
    expect(r2.changed).toBe(false)
    expect(r2.allowedChats).toEqual(['123'])

    // New chat id appends.
    const r3 = await captureTelegramPairing(paths, { chatId: '456' })
    expect(r3.changed).toBe(true)
    expect(r3.allowedChats).toEqual(['123', '456'])

    const cfg = await readFile(paths.configJson, 'utf8')
    expect(cfg).not.toContain('super-secret-do-not-leak')
    expect(cfg).toContain('"telegramTokenEnv": "MY_TOKEN_ENV"')
    expect(cfg).toContain('"123"')
    expect(cfg).toContain('"456"')
  })

  it('--telegram-chat captures chat id during init without persisting secrets', async () => {
    const out = await init(['--telegram-chat', '6477802820', '--telegram-token', 'leak-me-not'])
    const paths = relayMindPaths(workspace)
    const cfg = await readFile(paths.configJson, 'utf8')
    expect(cfg).toContain('"6477802820"')
    expect(cfg).not.toContain('leak-me-not')
    expect(out).toContain('add to your shell rc:')
  })

  it('installPluginBundle returns installed=false WITHOUT wiping existing files when bundle source is missing', async () => {
    const paths = relayMindPaths(workspace)
    await ensureProfileLayout(paths)
    // Seed a fake plugin tree so we can detect destructive behaviour.
    const dest = relayMindPluginPath(paths)
    await mkdir(join(dest, 'skills', 'fake'), { recursive: true })
    const sentinel = join(dest, 'skills', 'fake', 'SKILL.md')
    await writeFile(sentinel, '# do not delete\n', 'utf8')

    process.env.RELAYMIND_PLUGIN_ROOT = join(workspace, 'does-not-exist')
    try {
      const r = await installPluginBundle(paths)
      expect(r.installed).toBe(false)
      expect(r.filesWritten).toBe(0)
      // Critically: the previously-installed copy must remain.
      expect((await stat(sentinel)).isFile()).toBe(true)
      expect(await readFile(sentinel, 'utf8')).toBe('# do not delete\n')
    } finally {
      delete process.env.RELAYMIND_PLUGIN_ROOT
    }
  })

  it('installTelegramPluginIntoProfile returns installed=false WITHOUT wiping existing files when bundle source is missing', async () => {
    const paths = relayMindPaths(workspace)
    await ensureProfileLayout(paths)
    const dest = telegramPluginPath(paths)
    await mkdir(join(dest, '.claude-plugin'), { recursive: true })
    const sentinel = join(dest, '.claude-plugin', 'plugin.json')
    await writeFile(sentinel, '{"name":"vibemind-telegram"}\n', 'utf8')

    process.env.VIBERELAY_TELEGRAM_PLUGIN_ROOT = join(workspace, 'does-not-exist')
    try {
      const r = await installTelegramPluginIntoProfile(paths)
      expect(r.installed).toBe(false)
      expect(r.filesWritten).toBe(0)
      expect((await stat(sentinel)).isFile()).toBe(true)
    } finally {
      delete process.env.VIBERELAY_TELEGRAM_PLUGIN_ROOT
    }
  })

  it('locateRepoBundle finds a bundle next to a synthetic execPath (production layout)', async () => {
    // Build a fake install tree mirroring the production layout. The
    // installer extracts the binary and plugins/ side-by-side, so the
    // resolver looks at `<dirname(execPath)>/plugins/<short>/`.
    //   <stage>/relaymind           ← faux binary
    //   <stage>/plugins/relaymind/  ← short-name bundle dir
    const stage = join(workspace, 'stage-install')
    const pluginDir = join(stage, 'plugins', 'relaymind')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(stage, 'relaymind'), '#!/bin/sh\n', 'utf8')
    await writeFile(join(pluginDir, 'README.md'), '# fake\n', 'utf8')

    const originalExec = process.execPath
    Object.defineProperty(process, 'execPath', {
      value: join(stage, 'relaymind'),
      configurable: true,
      writable: true,
    })
    try {
      const found = await _locateBundleForTest({ short: 'relaymind', long: 'relaymind-plugin-cc' })
      // macOS resolves `/var/...` → `/private/var/...` via realpath, so
      // compare canonicalised paths.
      expect(found).not.toBeNull()
      expect(await realpath(found!)).toBe(await realpath(pluginDir))
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: originalExec,
        configurable: true,
        writable: true,
      })
    }
  })

  it('does not write secrets to disk — token is only referenced by env name', async () => {
    process.env.VIBERELAY_RELAYMIND_TOKEN = 'super-secret-do-not-leak'
    try {
      await init(['--token', 'VIBERELAY_RELAYMIND_TOKEN'])
      const paths = relayMindPaths(workspace)
      const config = await readFile(paths.configJson, 'utf8')
      expect(config).not.toContain('super-secret-do-not-leak')
      const settings = await readFile(join(paths.claudeProjectDir, 'settings.json'), 'utf8')
      expect(settings).not.toContain('super-secret-do-not-leak')
    } finally {
      delete process.env.VIBERELAY_RELAYMIND_TOKEN
    }
  })
})
