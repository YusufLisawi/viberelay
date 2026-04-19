import { spawn } from 'node:child_process'
import { access, mkdir, readlink, rm, symlink } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

export interface MenubarCommandOptions {
  argv?: string[]
}

const SWIFTBAR_DIR = 'Library/Application Support/SwiftBar/Plugins'
const XBAR_DIR = 'Library/Application Support/xbar/plugins'
const PLUGIN_FILE = 'viberelay.5s.sh'

function resolvePluginSource(): string {
  const isCompiled = import.meta.url.startsWith('file:///$bunfs/') || import.meta.url.includes('/$bunfs/root/')
  if (isCompiled) {
    return resolve(dirname(process.execPath), '..', 'resources', 'menubar', PLUGIN_FILE)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../../../resources/menubar', PLUGIN_FILE)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function detectHostDir(override?: string): Promise<{ dir: string, host: 'swiftbar' | 'xbar' | 'custom' } | null> {
  if (override) return { dir: override, host: 'custom' }
  const home = homedir()
  const swiftbar = resolve(home, SWIFTBAR_DIR)
  if (await exists(swiftbar)) return { dir: swiftbar, host: 'swiftbar' }
  const xbar = resolve(home, XBAR_DIR)
  if (await exists(xbar)) return { dir: xbar, host: 'xbar' }
  return null
}

function parseTarget(argv: string[]): string | undefined {
  const idx = argv.indexOf('--dir')
  return idx >= 0 ? argv[idx + 1] : undefined
}

export async function runMenubarCommand(options: MenubarCommandOptions): Promise<string> {
  if (platform() !== 'darwin') {
    return 'viberelay menubar is macOS-only (requires SwiftBar or xbar).'
  }
  const argv = options.argv ?? process.argv.slice(3)
  const sub = argv[0]
  switch (sub) {
    case 'install': return installPlugin(parseTarget(argv))
    case 'uninstall': return uninstallPlugin(parseTarget(argv))
    case 'status': return statusPlugin(parseTarget(argv))
    case 'path': return resolvePluginSource()
    case undefined:
    case 'help':
    case '--help':
      return usage()
    default:
      throw new Error(`Unknown menubar subcommand: ${sub}\n${usage()}`)
  }
}

function usage(): string {
  return [
    'viberelay menubar <command>',
    '',
    '  install [--dir <path>]    Symlink the SwiftBar plugin into the host plugin dir',
    '  uninstall [--dir <path>]  Remove the symlink',
    '  status [--dir <path>]     Show where the plugin is installed (if at all)',
    '  path                      Print the source path of the plugin script',
    '',
    'Install SwiftBar first:  brew install --cask swiftbar',
    'After install, the plugin polls `viberelay usage --once --json` every 5s.'
  ].join('\n')
}

async function installPlugin(override?: string): Promise<string> {
  const src = resolvePluginSource()
  if (!(await exists(src))) {
    throw new Error(`plugin source missing at ${src}`)
  }
  const host = await detectHostDir(override)
  if (!host) {
    return [
      'No SwiftBar or xbar plugin directory found.',
      '',
      'Install SwiftBar (recommended):',
      '  brew install --cask swiftbar',
      '',
      'Then re-run:  viberelay menubar install',
      '',
      'Or specify a custom directory:  viberelay menubar install --dir <path>'
    ].join('\n')
  }
  await mkdir(host.dir, { recursive: true })
  const dest = resolve(host.dir, PLUGIN_FILE)
  if (await exists(dest)) {
    await rm(dest)
  }
  await symlink(src, dest)
  if (host.host === 'swiftbar') {
    spawn('open', ['-gja', 'SwiftBar'], { stdio: 'ignore', detached: true }).unref()
  }
  return `installed ${PLUGIN_FILE} → ${dest} (${host.host})`
}

async function uninstallPlugin(override?: string): Promise<string> {
  const host = await detectHostDir(override)
  if (!host) return 'no SwiftBar/xbar directory found; nothing to do'
  const dest = resolve(host.dir, PLUGIN_FILE)
  if (!(await exists(dest))) return `not installed at ${dest}`
  await rm(dest)
  return `removed ${dest}`
}

async function statusPlugin(override?: string): Promise<string> {
  const src = resolvePluginSource()
  const host = await detectHostDir(override)
  if (!host) return `host: none\nsource: ${src}`
  const dest = resolve(host.dir, PLUGIN_FILE)
  if (!(await exists(dest))) return `host: ${host.host} (${host.dir})\ninstalled: no\nsource: ${src}`
  let target = ''
  try {
    target = await readlink(dest)
  } catch {
    target = '(regular file, not a symlink)'
  }
  return [
    `host: ${host.host} (${host.dir})`,
    `installed: yes`,
    `link: ${dest} → ${target}`,
    `source: ${src}`
  ].join('\n')
}
