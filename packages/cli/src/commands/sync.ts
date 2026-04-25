import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface SyncOptions {
  argv?: string[]
}

function helpText(): string {
  return `viberelay sync — copy auth tokens + settings to/from another machine

Usage:
  viberelay sync <user@host>             Push viberelay creds to remote (default)
  viberelay sync <user@host> --pull      Pull instead of push
  viberelay sync <user@host> --port 22   SSH port (default 22)
  viberelay sync <user@host> --dry-run   Show what would change, do nothing
  viberelay sync <user@host> --restart   Restart \`viberelay\` on the remote when done

Optional payloads (combine freely, or use --all):
  --profiles    ~/.viberelay/profiles/        viberelay profile JSON files
  --claude      ~/.claude/                    Claude global config (curated)
  --all         shorthand for --profiles --claude

Always synced:
  ~/.cli-proxy-api/*.json                     OAuth tokens + API keys
  ~/.viberelay/state/settings-state.json      Account labels, model groups, prefs

Claude curated set:
  CLAUDE.md, settings.json, keybindings.json
  agents/, commands/, hooks/, skills/, plugins/

Skipped under ~/.claude/: projects, sessions, history.jsonl, cache, paste-cache,
file-history, shell-snapshots, todos, plans, backups, debug, ide, .claude.json
(machine-local, large, or live-session state).

Requires \`rsync\` and \`ssh\` on both sides. A Tailscale IP works fine for <host>.`
}

interface ParsedArgs {
  target: string
  pull: boolean
  dryRun: boolean
  restart: boolean
  port: number
  withProfiles: boolean
  withClaude: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  let target = ''
  let pull = false
  let dryRun = false
  let restart = false
  let port = 22
  let withProfiles = false
  let withClaude = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--pull') pull = true
    else if (arg === '--dry-run' || arg === '-n') dryRun = true
    else if (arg === '--restart') restart = true
    else if (arg === '--profiles') withProfiles = true
    else if (arg === '--claude') withClaude = true
    else if (arg === '--all') { withProfiles = true; withClaude = true }
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

  return { target, pull, dryRun, restart, port, withProfiles, withClaude }
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

interface SyncJob {
  label: string
  localPath: string         // dir paths must end with '/'
  remotePath: string        // mirror of localPath shape
  isDir: boolean
  extraFlags?: string[]     // e.g. include/exclude rules
  remoteParents: string[]   // dirs to mkdir on remote before push
  localParents: string[]    // dirs to mkdir locally before pull
  softFail?: boolean        // settings/optional files may not exist yet
}

function buildJobs(args: ParsedArgs): SyncJob[] {
  const home = homedir()
  const jobs: SyncJob[] = []

  jobs.push({
    label: 'tokens',
    localPath: join(home, '.cli-proxy-api') + '/',
    remotePath: '~/.cli-proxy-api/',
    isDir: true,
    extraFlags: [
      '--include=*.json',
      '--exclude=config.yaml',
      '--exclude=merged-config.yaml',
      '--exclude=logs/',
      '--exclude=logs',
      '--exclude=*'
    ],
    remoteParents: ['~/.cli-proxy-api'],
    localParents: [join(home, '.cli-proxy-api')]
  })

  jobs.push({
    label: 'settings',
    localPath: join(home, '.viberelay', 'state', 'settings-state.json'),
    remotePath: '~/.viberelay/state/settings-state.json',
    isDir: false,
    remoteParents: ['~/.viberelay/state'],
    localParents: [join(home, '.viberelay', 'state')],
    softFail: true
  })

  if (args.withProfiles) {
    jobs.push({
      label: 'profiles',
      localPath: join(home, '.viberelay', 'profiles') + '/',
      remotePath: '~/.viberelay/profiles/',
      isDir: true,
      remoteParents: ['~/.viberelay/profiles'],
      localParents: [join(home, '.viberelay', 'profiles')],
      softFail: true
    })
  }

  if (args.withClaude) {
    // Curated subtree: top-level config files we want, dirs that hold user
    // customisations (skills/agents/commands/hooks/plugins). Everything else
    // under ~/.claude is machine-local or live state.
    const claudeIncludes = [
      '--include=CLAUDE.md',
      '--include=settings.json',
      '--include=keybindings.json',
      '--include=agents/',
      '--include=agents/**',
      '--include=commands/',
      '--include=commands/**',
      '--include=hooks/',
      '--include=hooks/**',
      '--include=skills/',
      '--include=skills/**',
      '--include=plugins/',
      '--include=plugins/**',
      '--exclude=*'
    ]
    jobs.push({
      label: 'claude config',
      localPath: join(home, '.claude') + '/',
      remotePath: '~/.claude/',
      isDir: true,
      extraFlags: claudeIncludes,
      remoteParents: ['~/.claude'],
      localParents: [join(home, '.claude')],
      softFail: true
    })
  }

  return jobs
}

export async function runSyncCommand(options: SyncOptions = {}): Promise<string> {
  const argv = options.argv ?? process.argv.slice(3)

  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return helpText()
  }

  const args = parseArgs(argv)
  if (!args.target) return helpText()

  const sshFlag = `ssh -p ${args.port}`
  const baseFlags = ['-az', '--stats', '-e', sshFlag]
  if (args.dryRun) baseFlags.push('--dry-run', '--itemize-changes')

  const jobs = buildJobs(args)

  // Make sure parent dirs exist on whichever side we're writing into.
  if (args.pull) {
    const parents = [...new Set(jobs.flatMap((job) => job.localParents))]
    if (parents.length > 0) await run('mkdir', ['-p', ...parents])
  } else {
    const parents = [...new Set(jobs.flatMap((job) => job.remoteParents))]
    if (parents.length > 0) {
      await run('ssh', ['-p', String(args.port), args.target, `mkdir -p ${parents.join(' ')}`])
    }
  }

  for (const job of jobs) {
    const flags = [...baseFlags, ...(job.extraFlags ?? [])]
    if (!args.pull && job.isDir) flags.push('--delete')

    const local = job.localPath
    const remote = `${args.target}:${job.remotePath}`
    const [src, dst] = args.pull ? [remote, local] : [local, remote]

    process.stdout.write(`→ ${args.pull ? 'pulling' : 'pushing'} ${job.label}: ${src} → ${dst}\n`)
    try {
      await run('rsync', [...flags, src, dst])
    } catch (error) {
      if (job.softFail) {
        process.stdout.write(`  (skipped ${job.label}: ${(error as Error).message})\n`)
        continue
      }
      throw error
    }
  }

  if (args.restart && !args.pull && !args.dryRun) {
    process.stdout.write(`→ restarting viberelay on ${args.target}\n`)
    await run('ssh', ['-p', String(args.port), args.target, 'viberelay restart'])
  }

  return `✓ ${args.pull ? 'pulled' : 'pushed'} viberelay credentials${args.dryRun ? ' (dry run)' : ''}`
}
