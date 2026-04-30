/**
 * `viberelay relaymind setup` — idempotent re-runner.
 *
 * Same as `init` but skips the wizard prompts and never overwrites context
 * files. Safe to call from automation, post-update scripts, or supervisor
 * self-healing. Performs the same dep-check + viberelay-profile creation
 * steps as init so a stale install can be repaired in one call.
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
import { checkAllDeps, tryAutoInstall } from '../../lib/deps.js'

const HELP = `viberelay relaymind setup

  Idempotent re-runner — safe to call from automation, post-update scripts,
  or supervisor self-healing. Never overwrites existing context files.

Usage:
  viberelay relaymind setup                          Re-run all setup steps
  viberelay relaymind setup --auto-install           Best-effort install of missing tmux/claude
  viberelay relaymind setup --no-telegram-plugin     Skip Telegram plugin install
  viberelay relaymind setup --profile-name <NAME>    Override viberelay profile name
  viberelay relaymind setup --opus-group <NAME>      Override opus model group
  viberelay relaymind setup --sonnet-group <NAME>    Override sonnet model group
  viberelay relaymind setup --haiku-group <NAME>     Override haiku model group
  viberelay relaymind setup --telegram-token <T>     Bot token (NOT written; only used for export hint)
  viberelay relaymind setup --telegram-chat <ID>     Allowlist this Telegram chat id
  viberelay relaymind setup --token-env <NAME>       Env-var name that holds the token`

interface SetupFlags {
  noTelegramPlugin: boolean
  autoInstall: boolean
  profileName?: string
  opusGroup?: string
  sonnetGroup?: string
  haikuGroup?: string
  telegramToken?: string
  telegramChat?: string
  tokenEnv?: string
}

function parseFlags(argv: string[]): SetupFlags {
  const flags: SetupFlags = { noTelegramPlugin: false, autoInstall: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-telegram-plugin') flags.noTelegramPlugin = true
    else if (a === '--auto-install') flags.autoInstall = true
    else if (a === '--profile-name') flags.profileName = argv[++i]
    else if (a === '--opus-group') flags.opusGroup = argv[++i]
    else if (a === '--sonnet-group') flags.sonnetGroup = argv[++i]
    else if (a === '--haiku-group') flags.haikuGroup = argv[++i]
    else if (a === '--telegram-token') flags.telegramToken = argv[++i]
    else if (a === '--telegram-chat') flags.telegramChat = argv[++i]
    else if (a === '--token' || a === '--token-env') flags.tokenEnv = argv[++i]
  }
  return flags
}

export default async function setup(argv: string[], baseUrl?: string): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return HELP
  }
  const flags = parseFlags(argv)
  const paths = relayMindPaths(process.cwd())
  const lines: string[] = ['viberelay relaymind setup']
  lines.push(`profile root: ${paths.claudeHome}`)

  // Dep checks (warn-only here; setup is for repair, callers may already
  // know the missing deps and want the rest of the steps to run).
  const deps = await checkAllDeps()
  for (const d of deps) {
    if (d.result.ok) {
      lines.push(`  [OK ] dep ${d.bin} — ${d.result.version}`)
    } else if (flags.autoInstall) {
      const r = await tryAutoInstall(d.bin, { force: true })
      lines.push(`  [${r.installed ? 'OK ' : 'WARN'}] dep ${d.bin} — ${r.reason}`)
    } else {
      lines.push(`  [WARN] dep ${d.bin} — missing; ${d.result.hint}`)
    }
  }

  await ensureProfileLayout(paths)
  lines.push('  [OK ] profile layout')

  const bundle = await installPluginBundle(paths)
  lines.push(
    `  [${bundle.installed ? 'OK ' : 'WARN'}] plugin bundle — ${
      bundle.installed
        ? `${bundle.filesWritten} file(s) copied`
        : 'bundle source missing — kept existing install'
    }`,
  )

  // force=false — context files are never overwritten on setup.
  const ctx = await writeContextFiles(paths, { force: false })
  const fresh = Object.entries(ctx.written).filter(([, v]) => v).map(([k]) => k)
  lines.push(`  [OK ] context files — ${fresh.length === 0 ? 'preserved existing' : `wrote ${fresh.join(', ')}`}`)

  const wroteRegistry = await writeDefaultRegistry(paths)
  lines.push(`  [OK ] command registry — ${wroteRegistry ? 'wrote default' : 'preserved existing'}`)

  const wroteConfig = await writeDefaultConfig(paths, {
    viberelayProfile: {
      name: flags.profileName,
      opus: flags.opusGroup,
      sonnet: flags.sonnetGroup,
      haiku: flags.haikuGroup,
    },
  })
  lines.push(`  [OK ] config — ${wroteConfig ? 'wrote default' : 'preserved existing'}`)

  await writeProfileSettings(paths)
  lines.push('  [OK ] .claude/settings.json')

  const wroteMarket = await writeProfileMarketplace(paths)
  lines.push(`  [OK ] .claude-plugin/marketplace.json — ${wroteMarket ? 'wrote' : 'preserved existing'}`)

  const trust = await preMarkWorkspaceTrusted(paths)
  lines.push(
    `  [${trust.ok ? 'OK ' : 'WARN'}] workspace trust — ${
      trust.ok ? (trust.changed ? `trusted ${trust.configPath}` : (trust.detail ?? 'already trusted')) : (trust.detail ?? 'failed')
    }`,
  )

  const isoCfg = await writeIsolatedClaudeConfig(paths)
  lines.push(
    `  [${isoCfg.ok ? 'OK ' : 'WARN'}] isolated claude config — ${
      isoCfg.ok
        ? isoCfg.changed
          ? `wrote ${isoCfg.settingsPath}`
          : (isoCfg.detail ?? 'already up to date')
        : (isoCfg.detail ?? 'failed')
    }`,
  )

  if (flags.noTelegramPlugin) {
    lines.push('  [OK ] telegram plugin — skipped (--no-telegram-plugin)')
  } else {
    const tg = await installTelegramPluginIntoProfile(paths)
    lines.push(
      `  [${tg.installed ? 'OK ' : 'WARN'}] telegram plugin — ${
        tg.installed ? `${tg.filesWritten} file(s) copied` : 'bundle source missing — kept existing install'
      }`,
    )
  }

  // Viberelay profile (best-effort; bare-claude fallback if this fails).
  if (baseUrl) {
    const profile = await ensureViberelayProfile(paths, {
      baseUrl,
      binding: {
        name: flags.profileName,
        opus: flags.opusGroup,
        sonnet: flags.sonnetGroup,
        haiku: flags.haikuGroup,
      },
    })
    lines.push(
      `  [${profile.ok ? 'OK ' : 'WARN'}] viberelay profile — ${
        profile.ok ? `'${profile.profileName}' ready` : profile.message
      }`,
    )
  } else {
    lines.push('  [WARN] viberelay profile — no baseUrl; supervisor will use bare-claude fallback')
  }

  // Telegram pairing capture (only when caller actually passed something).
  const envToken = flags.telegramToken ?? process.env.RELAYMIND_TELEGRAM_TOKEN
  const envChat = flags.telegramChat ?? process.env.RELAYMIND_TELEGRAM_CHAT
  if (flags.tokenEnv !== undefined || envToken !== undefined || envChat !== undefined) {
    const r = await captureTelegramPairing(paths, {
      tokenEnv: flags.tokenEnv,
      token: envToken,
      chatId: envChat,
    })
    lines.push(
      `  [OK ] telegram pairing — ${
        r.changed ? `recorded (token-env=${r.tokenEnv}${envChat ? `, chat=${envChat}` : ''})` : 'nothing new'
      }`,
    )
  }

  const v = await verifyInstallation(paths)
  lines.push(`  [${v.ok ? 'OK ' : 'WARN'}] verify — ${v.ok ? 'all paths present' : `${v.issues.length} issue(s)`}`)
  if (!v.ok) {
    for (const issue of v.issues) lines.push(`        · ${issue}`)
  }

  return lines.join('\n')
}
