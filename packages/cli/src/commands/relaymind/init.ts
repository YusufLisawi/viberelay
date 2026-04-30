/**
 * `viberelay relaymind init` — first-time setup wizard.
 *
 * Idempotent: re-running picks up where the previous run left off without
 * clobbering existing context files or the command registry. Pairing (the
 * actual bot-token-to-bot handshake) stays out of Claude per PRD §123/§871
 * — this command captures token/chat hints into config.json (env-var name
 * only; never the secret) and points the user at `viberelay telegram`.
 */

import process from 'node:process'

import { relayMindPaths } from '@viberelay/shared/relaymind'
import {
  captureTelegramPairing,
  ensureProfileLayout,
  ensureViberelayProfile,
  installPluginBundle,
  installTelegramPluginIntoProfile,
  preMarkWorkspaceTrusted,
  writeIsolatedClaudeConfig,
  verifyInstallation,
  writeContextFiles,
  writeDefaultConfig,
  writeDefaultRegistry,
  writeProfileMarketplace,
  writeProfileSettings,
} from '../../lib/profile-installer.js'
import { checkAllDeps, tryAutoInstall, type DepCheckResult } from '../../lib/deps.js'

const HELP = `viberelay relaymind init

  First-time setup wizard — checks host deps, creates the .relaymind profile,
  writes context files, installs the plugin bundle, creates the viberelay
  profile that the supervisor uses, and verifies the installation.

Usage:
  viberelay relaymind init                         Run the setup wizard
  viberelay relaymind init --force                 Overwrite existing context files
  viberelay relaymind init --auto-install          Best-effort install of missing tmux/claude
  viberelay relaymind init --session-name <name>   Set a custom session name hint
  viberelay relaymind init --token <ENV_VAR>       Env-var name that holds the token
  viberelay relaymind init --token-env <ENV_VAR>   Alias of --token
  viberelay relaymind init --telegram-token <T>    Bot token (used only to print export hint; NEVER written to disk)
  viberelay relaymind init --telegram-chat <ID>    Allowlist this Telegram chat id
  viberelay relaymind init --profile-name <NAME>   Viberelay profile name (default: relaymind)
  viberelay relaymind init --opus-group <NAME>     Model group alias for opus (default: high)
  viberelay relaymind init --sonnet-group <NAME>   Model group alias for sonnet (default: mid)
  viberelay relaymind init --haiku-group <NAME>    Model group alias for haiku (default: low)
  viberelay relaymind init --no-telegram-plugin    Skip Telegram plugin install

Env:
  RELAYMIND_TELEGRAM_TOKEN / VIBERELAY_RELAYMIND_TOKEN — bot token (read-only; only used to surface the export hint)
  RELAYMIND_TELEGRAM_CHAT — Telegram chat id to allowlist

Examples:
  viberelay relaymind init
  viberelay relaymind init --force --session-name myproject
  viberelay relaymind init --auto-install --telegram-chat 6477802820`

interface InitFlags {
  force: boolean
  autoInstall: boolean
  sessionName?: string
  tokenEnv?: string
  noTelegramPlugin: boolean
  telegramToken?: string
  telegramChat?: string
  profileName?: string
  opusGroup?: string
  sonnetGroup?: string
  haikuGroup?: string
}

function parseFlags(argv: string[]): InitFlags {
  const flags: InitFlags = { force: false, autoInstall: false, noTelegramPlugin: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force') flags.force = true
    else if (a === '--auto-install') flags.autoInstall = true
    else if (a === '--no-telegram-plugin') flags.noTelegramPlugin = true
    else if (a === '--session-name') flags.sessionName = argv[++i]
    else if (a === '--token' || a === '--token-env') flags.tokenEnv = argv[++i] ?? 'VIBERELAY_RELAYMIND_TOKEN'
    else if (a === '--telegram-token') flags.telegramToken = argv[++i]
    else if (a === '--telegram-chat') flags.telegramChat = argv[++i]
    else if (a === '--profile-name') flags.profileName = argv[++i]
    else if (a === '--opus-group') flags.opusGroup = argv[++i]
    else if (a === '--sonnet-group') flags.sonnetGroup = argv[++i]
    else if (a === '--haiku-group') flags.haikuGroup = argv[++i]
  }
  return flags
}

interface Step {
  label: string
  run: () => Promise<{ ok: boolean; note?: string }>
}

function tick(ok: boolean): string {
  return ok ? 'OK ' : 'WARN'
}

function describeDep(r: DepCheckResult): string {
  return r.ok ? r.version : `missing — ${r.hint}`
}

export default async function init(argv: string[], baseUrl?: string): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return HELP
  }
  const flags = parseFlags(argv)
  const paths = relayMindPaths(process.cwd())

  // Token: only a reference to an env var name is recorded — never the
  // literal value. Default mirrors the convention used in CLAUDE.md.
  const tokenEnvName = flags.tokenEnv ?? 'VIBERELAY_RELAYMIND_TOKEN'
  const envToken = flags.telegramToken
    ?? process.env.RELAYMIND_TELEGRAM_TOKEN
    ?? process.env[tokenEnvName]
  const envChat = flags.telegramChat ?? process.env.RELAYMIND_TELEGRAM_CHAT
  const tokenPresent = typeof envToken === 'string' && envToken !== ''

  const lines: string[] = []
  lines.push('viberelay relaymind init')
  lines.push(`profile root: ${paths.claudeHome}`)
  lines.push('')

  // ── Step 0: dep checks (run before anything else; can short-circuit) ──────
  const deps = await checkAllDeps()
  const missing = deps.filter((d) => !d.result.ok)
  let depsHardFail = false
  for (const d of deps) {
    lines.push(`  [${d.result.ok ? 'OK ' : 'FAIL'}] dep ${d.bin} — ${describeDep(d.result)}`)
  }
  if (missing.length > 0) {
    if (flags.autoInstall) {
      for (const d of missing) {
        const r = await tryAutoInstall(d.bin, { force: true })
        lines.push(`  [${r.installed ? 'OK ' : 'FAIL'}] auto-install ${d.bin} — ${r.reason}`)
        if (!r.installed) depsHardFail = true
      }
    } else {
      depsHardFail = true
    }
  }

  if (depsHardFail) {
    lines.push('')
    lines.push('install the prereqs and re-run `relaymind init`:')
    for (const d of missing) {
      if (!d.result.ok) lines.push(`  - ${d.result.hint}`)
    }
    lines.push('  (or pass --auto-install to attempt installation automatically)')
    // Non-zero exit is the registrar's call; we mark it via the message.
    return lines.join('\n')
  }

  const steps: Step[] = [
    {
      label: 'profile layout',
      run: async () => {
        await ensureProfileLayout(paths)
        return { ok: true }
      },
    },
    {
      label: 'plugin bundle',
      run: async () => {
        const r = await installPluginBundle(paths)
        if (!r.installed) return { ok: false, note: 'bundle source missing — kept existing install' }
        return { ok: true, note: `${r.filesWritten} file(s) copied` }
      },
    },
    {
      label: `context files${flags.force ? ' (forced)' : ''}`,
      run: async () => {
        const { written } = await writeContextFiles(paths, { force: flags.force })
        const fresh = Object.entries(written).filter(([, v]) => v).map(([k]) => k)
        const note = fresh.length === 0 ? 'preserved existing' : `wrote ${fresh.join(', ')}`
        return { ok: true, note }
      },
    },
    {
      label: 'command registry',
      run: async () => {
        const wrote = await writeDefaultRegistry(paths)
        return { ok: true, note: wrote ? 'wrote default registry' : 'preserved existing registry' }
      },
    },
    {
      label: 'config',
      run: async () => {
        const wrote = await writeDefaultConfig(paths, {
          viberelayProfile: {
            name: flags.profileName,
            opus: flags.opusGroup,
            sonnet: flags.sonnetGroup,
            haiku: flags.haikuGroup,
          },
        })
        return { ok: true, note: wrote ? 'wrote default config' : 'preserved existing config' }
      },
    },
    {
      label: '.claude/settings.json',
      run: async () => {
        await writeProfileSettings(paths)
        return { ok: true }
      },
    },
    {
      label: '.claude-plugin/marketplace.json',
      run: async () => {
        const wrote = await writeProfileMarketplace(paths)
        return { ok: true, note: wrote ? 'wrote profile marketplace' : 'preserved existing' }
      },
    },
    {
      label: 'workspace trust',
      run: async () => {
        const r = await preMarkWorkspaceTrusted(paths)
        if (!r.ok) return { ok: false, note: r.detail ?? 'failed' }
        return { ok: true, note: r.changed ? `trusted ${r.configPath}` : (r.detail ?? 'already trusted') }
      },
    },
    {
      label: 'isolated claude config',
      run: async () => {
        const r = await writeIsolatedClaudeConfig(paths)
        if (!r.ok) return { ok: false, note: r.detail ?? 'failed' }
        return { ok: true, note: r.changed ? `wrote ${r.settingsPath}` : (r.detail ?? 'already up to date') }
      },
    },
    {
      label: 'telegram plugin',
      run: async () => {
        if (flags.noTelegramPlugin) return { ok: true, note: 'skipped (--no-telegram-plugin)' }
        const r = await installTelegramPluginIntoProfile(paths)
        if (!r.installed) return { ok: false, note: 'bundle source missing — kept existing install' }
        return { ok: true, note: `${r.filesWritten} file(s) copied` }
      },
    },
    {
      label: 'viberelay profile',
      run: async () => {
        if (!baseUrl) {
          return { ok: false, note: 'no baseUrl available; skipped (supervisor will use bare-claude fallback)' }
        }
        const r = await ensureViberelayProfile(paths, {
          baseUrl,
          binding: {
            name: flags.profileName,
            opus: flags.opusGroup,
            sonnet: flags.sonnetGroup,
            haiku: flags.haikuGroup,
          },
        })
        return { ok: r.ok, note: r.ok ? `created/updated profile '${r.profileName}'` : `skipped — ${r.message}` }
      },
    },
    {
      label: 'telegram pairing',
      run: async () => {
        const r = await captureTelegramPairing(paths, {
          tokenEnv: flags.tokenEnv,
          token: envToken,
          chatId: envChat,
        })
        if (!r.changed) return { ok: true, note: 'nothing new to record' }
        const parts: string[] = []
        if (flags.tokenEnv !== undefined || envToken !== undefined) parts.push(`token-env=${r.tokenEnv}`)
        if (envChat !== undefined && envChat !== '') parts.push(`chat=${envChat} added`)
        return { ok: true, note: parts.join(', ') }
      },
    },
    {
      label: 'verify',
      run: async () => {
        const v = await verifyInstallation(paths)
        return { ok: v.ok, note: v.ok ? 'all paths present' : `${v.issues.length} issue(s)` }
      },
    },
  ]

  for (const step of steps) {
    try {
      const r = await step.run()
      lines.push(`  [${tick(r.ok)}] ${step.label}${r.note ? ` — ${r.note}` : ''}`)
    } catch (err) {
      lines.push(`  [WARN] ${step.label} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Session-name and token references are recorded only as hints — the
  // supervisor (Agent C) wires them into config.json on first start.
  lines.push('')
  if (flags.sessionName) lines.push(`session name override: ${flags.sessionName}`)
  lines.push(`telegram token env: ${tokenEnvName}${tokenPresent ? ' (present)' : ' (not set yet)'}`)
  if (envToken !== undefined && envToken !== '') {
    // The literal token is captured only for this hint — never persisted.
    lines.push(`add to your shell rc:  export ${tokenEnvName}=<your-token>`)
  }
  lines.push('')
  lines.push('next steps:')
  lines.push(`  1. Set bot token:   export ${tokenEnvName}=<token-from-BotFather>`)
  lines.push('  2. Verify health:   relaymind doctor')
  lines.push('  3. Start session:   relaymind start')
  lines.push('')
  lines.push('Pairing = (a) bot token in env above + (b) chat id in config.allowedChats.')
  lines.push('Pass --telegram-chat <id> to relaymind init/setup to add a chat id.')

  return lines.join('\n')
}
