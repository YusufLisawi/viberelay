import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface SyncOptions {
  argv?: string[]
}

function helpText(): string {
  return `viberelay sync — copy auth tokens + settings to/from another machine

Usage:
  viberelay sync <user@host>             Push local creds to remote (default)
  viberelay sync <user@host> --pull      Pull remote creds onto this machine
  viberelay sync <user@host> --port 22   SSH port (default 22)
  viberelay sync <user@host> --dry-run   Show what would change, do nothing
  viberelay sync <user@host> --restart   Restart \`viberelay\` on the remote when done

Synchronizes:
  ~/.cli-proxy-api/*.json           OAuth tokens + API keys
  ~/.viberelay/state/settings-state.json   Account labels, model groups, prefs

Skipped: config.yaml, logs, daemon.pid, static assets — they belong to each host.

Requires \`rsync\` and \`ssh\` on both sides (Ubuntu has them by default).
A Tailscale IP works fine for <host>.`
}

function parseArgs(argv: string[]) {
  let target = ''
  let pull = false
  let dryRun = false
  let restart = false
  let port = 22

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--pull') pull = true
    else if (arg === '--dry-run' || arg === '-n') dryRun = true
    else if (arg === '--restart') restart = true
    else if (arg === '--port' || arg === '-p') {
      const next = argv[++i]
      const parsed = next ? Number.parseInt(next, 10) : NaN
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--port requires a positive integer (got ${next ?? '<none>'})`)
      }
      port = parsed
    } else if (!arg.startsWith('-')) {
      if (target) throw new Error(`unexpected positional argument: ${arg}`)
      target = arg
    } else {
      throw new Error(`unknown flag: ${arg}`)
    }
  }

  return { target, pull, dryRun, restart, port }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

export async function runSyncCommand(options: SyncOptions = {}): Promise<string> {
  const argv = options.argv ?? process.argv.slice(3)

  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return helpText()
  }

  const { target, pull, dryRun, restart, port } = parseArgs(argv)
  if (!target) return helpText()

  const home = homedir()
  const localTokensDir = join(home, '.cli-proxy-api') + '/'
  const localStateFile = join(home, '.viberelay', 'state', 'settings-state.json')
  const remoteTokensDir = `${target}:~/.cli-proxy-api/`
  const remoteStateFile = `${target}:~/.viberelay/state/settings-state.json`

  const sshFlag = `ssh -p ${port}`

  // Make sure target dirs exist on the remote (push) or local (pull).
  if (pull) {
    await run('mkdir', ['-p', join(home, '.cli-proxy-api'), join(home, '.viberelay', 'state')])
  } else {
    await run('ssh', ['-p', String(port), target, 'mkdir -p ~/.cli-proxy-api ~/.viberelay/state'])
  }

  const baseFlags = ['-az', '--info=stats1', '-e', sshFlag]
  if (dryRun) baseFlags.push('--dry-run', '--itemize-changes')

  // Token directory: only carry actual auth files, never logs or derived configs.
  const tokenFlags = [
    ...baseFlags,
    '--include=*.json',
    '--exclude=config.yaml',
    '--exclude=merged-config.yaml',
    '--exclude=logs/',
    '--exclude=logs',
    '--exclude=*'
  ]
  // --delete is push-only by default to avoid wiping a populated local dir on pull.
  if (!pull) tokenFlags.push('--delete')

  const [tokenSrc, tokenDst] = pull ? [remoteTokensDir, localTokensDir] : [localTokensDir, remoteTokensDir]
  const [stateSrc, stateDst] = pull ? [remoteStateFile, localStateFile] : [localStateFile, remoteStateFile]

  process.stdout.write(`→ syncing tokens (${pull ? 'pull' : 'push'}): ${tokenSrc} → ${tokenDst}\n`)
  await run('rsync', [...tokenFlags, tokenSrc, tokenDst])

  process.stdout.write(`→ syncing settings: ${stateSrc} → ${stateDst}\n`)
  try {
    await run('rsync', [...baseFlags, stateSrc, stateDst])
  } catch (error) {
    // Settings file may not exist yet on a fresh install — soft-fail with a hint.
    process.stdout.write(`  (skipped: ${(error as Error).message})\n`)
  }

  if (restart && !pull && !dryRun) {
    process.stdout.write(`→ restarting viberelay on ${target}\n`)
    await run('ssh', ['-p', String(port), target, 'viberelay restart'])
  }

  return `✓ ${pull ? 'pulled' : 'pushed'} viberelay credentials${dryRun ? ' (dry run)' : ''}`
}
