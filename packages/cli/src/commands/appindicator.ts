import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface AppIndicatorCommandOptions {
  argv?: string[]
  platformName?: NodeJS.Platform
  homeDir?: string
  autostartDir?: string
  commandRunner?: (cmd: string, args: string[]) => Promise<CommandResult>
  indicatorStarter?: (helperPath: string) => Promise<void>
  bindingsAvailable?: boolean
}

const HELPER_FILE = 'viberelay-appindicator.py'
const DESKTOP_FILE = 'viberelay-appindicator.desktop'
const DESKTOP_TEMPLATE_FILE = 'viberelay-appindicator.desktop'
const PLACEHOLDER_HELPER = '__HELPER__'

function resolveResourcePath(file: string): string {
  const isCompiled = import.meta.url.startsWith('file:///$bunfs/') || import.meta.url.includes('/$bunfs/root/')
  if (isCompiled) {
    return resolve(dirname(process.execPath), '..', 'resources', 'appindicator', file)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../../../resources/appindicator', file)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function defaultInstallDir(homeDir = homedir()): string {
  return resolve(homeDir, '.config', 'viberelay', 'appindicator')
}

function defaultAutostartDir(homeDir = homedir()): string {
  return resolve(homeDir, '.config', 'autostart')
}

function usage(): string {
  return [
    'viberelay appindicator <command>',
    '',
    '  install [--dir <path>]    Install the GNOME top-bar helper + autostart entry',
    '  uninstall [--dir <path>]  Remove the GNOME top-bar helper + autostart entry',
    '  status [--dir <path>]     Show whether the GNOME top-bar helper is installed',
    '  path                      Print the bundled appindicator helper path',
    '',
    'Ubuntu GNOME needs python3-gi and gir1.2-ayatanaappindicator3-0.1 installed.',
    'The install step writes an autostart desktop entry and starts the indicator now.'
  ].join('\n')
}

function parseTarget(argv: string[], homeDir?: string): string {
  const idx = argv.indexOf('--dir')
  if (idx >= 0) {
    const value = argv[idx + 1]
    if (!value || value.startsWith('-')) {
      throw new Error(`Missing value for --dir\n${usage()}`)
    }
    return value
  }
  return defaultInstallDir(homeDir)
}

function indicatorBindingsAvailable(): boolean {
  return spawnSync('python3', ['-c', "import gi; gi.require_version('Gtk', '3.0'); gi.require_version('AyatanaAppIndicator3', '0.1'); from gi.repository import Gtk, AyatanaAppIndicator3"], { stdio: 'ignore' }).status === 0
}

async function renderDesktopTemplate(helperPath: string): Promise<string> {
  const template = await readFile(resolveResourcePath(DESKTOP_TEMPLATE_FILE), 'utf8')
  return template.replace(PLACEHOLDER_HELPER, helperPath)
}

async function runCommand(cmd: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', () => resolve({ code: 1, stdout, stderr }))
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function startIndicator(helperPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('python3', [helperPath], { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function stopIndicator(helperPath: string, runner: (cmd: string, args: string[]) => Promise<CommandResult>): Promise<void> {
  await runner('pkill', ['-f', helperPath]).catch(() => undefined)
}

async function listIndicatorProcesses(helperPath: string, runner: (cmd: string, args: string[]) => Promise<CommandResult>): Promise<string[]> {
  const result = await runner('pgrep', ['-af', helperPath]).catch(() => ({ code: 1, stdout: '', stderr: '' }))
  if (result.code !== 0 || result.stdout.trim().length === 0) return []
  return result.stdout.trim().split('\n').filter(Boolean)
}

async function installAppIndicator(targetDir: string, options: AppIndicatorCommandOptions): Promise<string> {
  const helperSource = resolveResourcePath(HELPER_FILE)
  const desktopTemplate = resolveResourcePath(DESKTOP_TEMPLATE_FILE)
  for (const path of [helperSource, desktopTemplate]) {
    if (!(await exists(path))) throw new Error(`appindicator resource missing at ${path}`)
  }
  const bindingsReady = options.bindingsAvailable ?? indicatorBindingsAvailable()
  if (!bindingsReady) {
    return [
      'Missing GNOME AppIndicator Python bindings.',
      '',
      'Install them on Ubuntu, then re-run `viberelay appindicator install`:',
      '  sudo apt install -y gir1.2-ayatanaappindicator3-0.1 python3-gi'
    ].join('\n')
  }

  const autostartDir = options.autostartDir ?? defaultAutostartDir(options.homeDir)
  await mkdir(targetDir, { recursive: true })
  await mkdir(autostartDir, { recursive: true })
  const helperDest = resolve(targetDir, HELPER_FILE)
  const desktopDest = resolve(autostartDir, DESKTOP_FILE)

  if (await exists(helperDest)) await rm(helperDest)
  await symlink(helperSource, helperDest)
  await writeFile(desktopDest, await renderDesktopTemplate(helperDest), 'utf8')

  const runner = options.commandRunner ?? runCommand
  await stopIndicator(helperDest, runner)
  await (options.indicatorStarter ?? startIndicator)(helperDest)

  return [
    `installed GNOME top-bar indicator in ${targetDir}`,
    `helper: ${helperDest}`,
    `autostart entry: ${desktopDest}`,
    '',
    'The indicator has been started for this session.',
    'It should also start automatically on your next login.'
  ].join('\n')
}

async function uninstallAppIndicator(targetDir: string, options: AppIndicatorCommandOptions): Promise<string> {
  const helperDest = resolve(targetDir, HELPER_FILE)
  const autostartDir = options.autostartDir ?? defaultAutostartDir(options.homeDir)
  const desktopDest = resolve(autostartDir, DESKTOP_FILE)
  const runner = options.commandRunner ?? runCommand
  await stopIndicator(helperDest, runner)
  await rm(helperDest, { force: true })
  await rm(desktopDest, { force: true })
  return `removed GNOME top-bar indicator files from ${targetDir}`
}

async function statusAppIndicator(targetDir: string, options: AppIndicatorCommandOptions): Promise<string> {
  const helperSource = resolveResourcePath(HELPER_FILE)
  const helperDest = resolve(targetDir, HELPER_FILE)
  const autostartDir = options.autostartDir ?? defaultAutostartDir(options.homeDir)
  const desktopDest = resolve(autostartDir, DESKTOP_FILE)
  const helperInstalled = await exists(helperDest)
  const autostartInstalled = await exists(desktopDest)
  const runner = options.commandRunner ?? runCommand
  const processes = helperInstalled ? await listIndicatorProcesses(helperDest, runner) : []
  if (!helperInstalled) {
    return [
      `dir: ${targetDir}`,
      'installed: no',
      `helper source: ${helperSource}`,
      `autostart entry: ${autostartInstalled ? desktopDest : '(missing)'}`,
      'running: no'
    ].join('\n')
  }

  let target = ''
  try {
    target = await readlink(helperDest)
  } catch {
    target = '(regular file, not a symlink)'
  }
  const fullyInstalled = helperInstalled && autostartInstalled
  const missing = !autostartInstalled ? basename(desktopDest) : ''
  return [
    `dir: ${targetDir}`,
    `installed: ${fullyInstalled ? 'yes' : 'partial'}`,
    `helper: ${helperDest} → ${target}`,
    `autostart entry: ${autostartInstalled ? desktopDest : '(missing)'}`,
    `running: ${processes.length > 0 ? 'yes' : 'no'}`,
    missing ? `missing: ${missing}` : ''
  ].filter(Boolean).join('\n')
}

export async function runAppIndicatorCommand(options: AppIndicatorCommandOptions): Promise<string> {
  const argv = options.argv ?? process.argv.slice(3)
  const sub = argv[0]
  switch (sub) {
    case undefined:
    case 'help':
    case '--help':
      return usage()
    case 'path':
      return resolveResourcePath(HELPER_FILE)
  }

  if ((options.platformName ?? platform()) !== 'linux') {
    return 'viberelay appindicator is Linux-only (for GNOME AppIndicator-capable desktops).'
  }

  const targetDir = parseTarget(argv, options.homeDir)
  switch (sub) {
    case 'install':
      return await installAppIndicator(targetDir, options)
    case 'uninstall':
      return await uninstallAppIndicator(targetDir, options)
    case 'status':
      return await statusAppIndicator(targetDir, options)
    default:
      throw new Error(`Unknown appindicator subcommand: ${sub}\n${usage()}`)
  }
}
