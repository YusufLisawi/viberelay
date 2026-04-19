import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { resolveDaemonPaths } from '../lib/daemon-control.js'

export interface ServiceCommandOptions {
  argv?: string[]
}

export async function runServiceCommand(options: ServiceCommandOptions): Promise<string> {
  const argv = options.argv ?? process.argv.slice(3)
  const sub = argv[0]

  switch (sub) {
    case 'install': return installService()
    case 'uninstall': return uninstallService()
    case 'status': return statusService()
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
    'Usage: viberelay service <install|uninstall|status>',
    '',
    'Registers viberelay-daemon with the OS service manager (launchd on',
    'macOS, systemd --user on Linux) so the daemon auto-starts on login.'
  ].join('\n')
}

async function installService(): Promise<string> {
  const os = platform()
  switch (os) {
    case 'darwin': return installLaunchd()
    case 'linux': return installSystemd()
    case 'win32': return 'service install: Windows auto-start not supported yet. Run viberelay-daemon manually or add to Task Scheduler.'
    default: throw new Error(`service install: unsupported OS ${os}`)
  }
}

async function uninstallService(): Promise<string> {
  const os = platform()
  switch (os) {
    case 'darwin': return uninstallLaunchd()
    case 'linux': return uninstallSystemd()
    default: return 'service uninstall: nothing to do on this OS'
  }
}

async function statusService(): Promise<string> {
  const os = platform()
  if (os === 'darwin') {
    const { stdout } = await runCapture('launchctl', ['list', 'com.viberelay.daemon'])
    return stdout.trim() || 'not loaded'
  }
  if (os === 'linux') {
    const { stdout } = await runCapture('systemctl', ['--user', 'status', 'viberelay.service', '--no-pager'])
    return stdout.trim() || 'not loaded'
  }
  return 'service status not supported on this OS'
}

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.viberelay.daemon.plist')
}

async function installLaunchd(): Promise<string> {
  const paths = resolveDaemonPaths()
  await access(paths.daemonBinary)
  await mkdir(paths.stateDir, { recursive: true })
  const plistPath = launchdPlistPath()
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  const plist = buildLaunchdPlist(paths.daemonBinary, paths.logFile, join(paths.stateDir, 'daemon.err'))
  await writeFile(plistPath, plist, 'utf8')
  await runOrThrow('launchctl', ['unload', plistPath]).catch(() => undefined)
  await runOrThrow('launchctl', ['load', '-w', plistPath])
  return `installed launchd agent at ${plistPath} (autostarts on login)`
}

async function uninstallLaunchd(): Promise<string> {
  const plistPath = launchdPlistPath()
  await runOrThrow('launchctl', ['unload', plistPath]).catch(() => undefined)
  await rm(plistPath, { force: true })
  return `removed ${plistPath}`
}

function buildLaunchdPlist(binary: string, outLog: string, errLog: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.viberelay.daemon</string>
  <key>ProgramArguments</key><array><string>${escapeXml(binary)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(errLog)}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'viberelay.service')
}

async function installSystemd(): Promise<string> {
  const paths = resolveDaemonPaths()
  await access(paths.daemonBinary)
  await mkdir(paths.stateDir, { recursive: true })
  const unitPath = systemdUnitPath()
  await mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true })
  const unit = `[Unit]
Description=viberelay daemon
After=network.target

[Service]
Type=simple
ExecStart=${paths.daemonBinary}
Restart=on-failure
RestartSec=3
StandardOutput=append:${paths.logFile}
StandardError=append:${paths.logFile}

[Install]
WantedBy=default.target
`
  await writeFile(unitPath, unit, 'utf8')
  await runOrThrow('systemctl', ['--user', 'daemon-reload'])
  await runOrThrow('systemctl', ['--user', 'enable', '--now', 'viberelay.service'])
  return `installed systemd user unit at ${unitPath} (autostarts on login)`
}

async function uninstallSystemd(): Promise<string> {
  const unitPath = systemdUnitPath()
  await runOrThrow('systemctl', ['--user', 'disable', '--now', 'viberelay.service']).catch(() => undefined)
  await rm(unitPath, { force: true })
  await runOrThrow('systemctl', ['--user', 'daemon-reload']).catch(() => undefined)
  return `removed ${unitPath}`
}

async function runOrThrow(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
  })
}

async function runCapture(cmd: string, args: string[]): Promise<{ stdout: string, stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('exit', () => resolve({ stdout, stderr }))
    child.on('error', () => resolve({ stdout, stderr }))
  })
}
