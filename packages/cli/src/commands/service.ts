import { spawn } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { resolveDaemonPaths } from '../lib/daemon-control.js'

export interface ServiceCommandOptions {
  argv?: string[]
}

export async function runServiceCommand(options: ServiceCommandOptions): Promise<string> {
  const argv = options.argv ?? process.argv.slice(3)
  const [sub, ...rest] = argv

  switch (sub) {
    case 'install':       return installUnit(daemonUnit())
    case 'uninstall':     return uninstallUnit(daemonUnit())
    case 'status':        return statusUnit(daemonUnit())
    case 'install-run':   return installUnit(runUnit(parseRunArgs(rest)))
    case 'uninstall-run': return uninstallUnit(runUnit(parseRunArgs(rest)))
    case 'status-run':    return statusUnit(runUnit(parseRunArgs(rest)))
    case undefined:
    case 'help':
    case '--help':
      return serviceUsage()
    default:
      throw new Error(`Unknown service subcommand: ${sub}\n${serviceUsage()}`)
  }
}

function serviceUsage(): string {
  return [
    'Usage:',
    '  viberelay service <install|uninstall|status>',
    '    Manages viberelay-daemon (the proxy). Auto-starts on login.',
    '',
    '  viberelay service <install-run|uninstall-run|status-run> <profile>',
    '    [--resume <id>] [--channels <spec>] [--memory-max <size>]',
    '    Manages a supervised `viberelay run` session that auto-restarts',
    '    on crash or memory bloat. Default --memory-max=4G (systemd only).',
    '',
    'Backed by launchd (macOS) or systemd --user (Linux).'
  ].join('\n')
}

// ── Service units ─────────────────────────────────────────────────────────

interface ServiceUnit {
  /** Unit filename stem (systemd: `<label>.service`, launchd: derived label). */
  label: string
  /** argv to launch. exec[0] is checked for existence. */
  exec: string[]
  logFile: string
  errFile?: string
  /** systemd MemoryMax=<size>; ignored on launchd. */
  memoryMax?: string
  /** systemd Restart= mode. Default 'on-failure'. */
  restart?: 'always' | 'on-failure'
}

function daemonUnit(): ServiceUnit {
  const paths = resolveDaemonPaths()
  return {
    label: 'viberelay',
    exec: [paths.daemonBinary],
    logFile: paths.logFile,
    errFile: join(paths.stateDir, 'daemon.err')
  }
}

interface RunOpts {
  profile: string
  resume?: string
  channels?: string
  memoryMax?: string
}

function runUnit(opts: RunOpts): ServiceUnit {
  const paths = resolveDaemonPaths()
  return {
    label: `viberelay-run-${opts.profile}`,
    exec: buildRunExec(opts),
    logFile: join(paths.stateDir, `run-${opts.profile}.log`),
    memoryMax: opts.memoryMax ?? '4G',
    restart: 'always'
  }
}

function buildRunExec(opts: RunOpts): string[] {
  const exe = process.platform === 'win32' ? 'viberelay.exe' : 'viberelay'
  const bin = process.env.VIBERELAY_BINARY ?? join(dirname(process.execPath), exe)
  const argv = [bin, 'run', '-d', opts.profile]
  if (opts.resume) argv.push('--resume', opts.resume)
  if (opts.channels) argv.push('--channels', opts.channels)
  return argv
}

function parseRunArgs(args: string[]): RunOpts {
  const profile = args[0]
  if (!profile || profile.startsWith('-')) {
    throw new Error('service: <profile> is required (e.g. install-run vibe --channels plugin:telegram@telegram-official)')
  }
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  return { profile, resume: get('--resume'), channels: get('--channels'), memoryMax: get('--memory-max') }
}

// ── Install / uninstall / status (platform dispatch) ──────────────────────

async function installUnit(unit: ServiceUnit): Promise<string> {
  await access(unit.exec[0])
  await mkdir(dirname(unit.logFile), { recursive: true })
  switch (platform()) {
    case 'darwin': return installLaunchd(unit)
    case 'linux':  return installSystemd(unit)
    case 'win32':  return `service install: Windows auto-start not supported. Run ${unit.label} manually or add to Task Scheduler.`
    default:       throw new Error(`service install: unsupported OS ${platform()}`)
  }
}

async function uninstallUnit(unit: ServiceUnit): Promise<string> {
  switch (platform()) {
    case 'darwin': return uninstallLaunchd(unit)
    case 'linux':  return uninstallSystemd(unit)
    default:       return 'service uninstall: nothing to do on this OS'
  }
}

async function statusUnit(unit: ServiceUnit): Promise<string> {
  if (platform() === 'darwin') {
    const { stdout } = await runCapture('launchctl', ['list', launchdLabel(unit)])
    return stdout.trim() || 'not loaded'
  }
  if (platform() === 'linux') {
    const { stdout } = await runCapture('systemctl', ['--user', 'status', `${unit.label}.service`, '--no-pager'])
    return stdout.trim() || 'not loaded'
  }
  return 'service status not supported on this OS'
}

// ── launchd ───────────────────────────────────────────────────────────────

// Preserves the legacy `com.viberelay.daemon` label for the daemon unit so
// existing installs keep working after upgrade.
function launchdLabel(unit: ServiceUnit): string {
  return unit.label === 'viberelay' ? 'com.viberelay.daemon' : `com.${unit.label.replace(/-/g, '.')}`
}

function launchdPlistPath(unit: ServiceUnit): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(unit)}.plist`)
}

async function installLaunchd(unit: ServiceUnit): Promise<string> {
  const plistPath = launchdPlistPath(unit)
  await mkdir(dirname(plistPath), { recursive: true })
  await writeFile(plistPath, buildLaunchdPlist(unit), 'utf8')
  await runOrThrow('launchctl', ['unload', plistPath]).catch(() => undefined)
  await runOrThrow('launchctl', ['load', '-w', plistPath])
  return `installed launchd agent at ${plistPath} (autostarts on login)`
}

async function uninstallLaunchd(unit: ServiceUnit): Promise<string> {
  const plistPath = launchdPlistPath(unit)
  await runOrThrow('launchctl', ['unload', plistPath]).catch(() => undefined)
  await rm(plistPath, { force: true })
  return `removed ${plistPath}`
}

function buildLaunchdPlist(unit: ServiceUnit): string {
  const args = unit.exec.map((a) => `<string>${escapeXml(a)}</string>`).join('')
  const errPath = unit.errFile ?? unit.logFile
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel(unit)}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(unit.logFile)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(errPath)}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── systemd --user ────────────────────────────────────────────────────────

function systemdUnitPath(unit: ServiceUnit): string {
  return join(homedir(), '.config', 'systemd', 'user', `${unit.label}.service`)
}

async function installSystemd(unit: ServiceUnit): Promise<string> {
  const unitPath = systemdUnitPath(unit)
  await mkdir(dirname(unitPath), { recursive: true })
  await writeFile(unitPath, buildSystemdUnit(unit), 'utf8')
  await runOrThrow('systemctl', ['--user', 'daemon-reload'])
  await runOrThrow('systemctl', ['--user', 'enable', '--now', `${unit.label}.service`])
  return `installed systemd user unit at ${unitPath} (autostarts on login). To survive reboot without an active login session, run: loginctl enable-linger $USER`
}

async function uninstallSystemd(unit: ServiceUnit): Promise<string> {
  const unitPath = systemdUnitPath(unit)
  await runOrThrow('systemctl', ['--user', 'disable', '--now', `${unit.label}.service`]).catch(() => undefined)
  await rm(unitPath, { force: true })
  await runOrThrow('systemctl', ['--user', 'daemon-reload']).catch(() => undefined)
  return `removed ${unitPath}`
}

function buildSystemdUnit(unit: ServiceUnit): string {
  const exec = unit.exec.map(shellQuote).join(' ')
  const restart = unit.restart ?? 'on-failure'
  const restartSec = restart === 'always' ? 5 : 3
  const memoryLine = unit.memoryMax ? `MemoryMax=${unit.memoryMax}\n` : ''
  return `[Unit]
Description=${unit.label}
After=network.target

[Service]
Type=simple
ExecStart=${exec}
Restart=${restart}
RestartSec=${restartSec}
${memoryLine}StandardOutput=append:${unit.logFile}
StandardError=append:${unit.logFile}

[Install]
WantedBy=default.target
`
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

// ── Process helpers ───────────────────────────────────────────────────────

async function runOrThrow(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
  })
}

async function runCapture(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args)
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.on('exit', () => resolve({ stdout }))
    child.on('error', () => resolve({ stdout }))
  })
}
