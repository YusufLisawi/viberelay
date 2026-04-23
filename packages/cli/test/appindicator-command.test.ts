import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAppIndicatorCommand } from '../src/commands/appindicator.js'

let target: string
let autostart: string

beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), 'viberelay-appindicator-'))
  autostart = await mkdtemp(join(tmpdir(), 'viberelay-autostart-'))
})

afterEach(async () => {
  await rm(target, { recursive: true, force: true })
  await rm(autostart, { recursive: true, force: true })
})

describe('appindicator command', () => {
  const noOpRunner = async () => ({ code: 1, stdout: '', stderr: '' })
  const noOpStarter = async () => {}

  it('prints usage when no subcommand', async () => {
    const output = await runAppIndicatorCommand({ argv: [] })
    expect(output).toContain('viberelay appindicator <command>')
    expect(output).toContain('install')
  })

  it('prints the bundled helper path', async () => {
    const output = await runAppIndicatorCommand({ argv: ['path'] })
    expect(output).toMatch(/resources\/appindicator\/viberelay-appindicator\.py$/)
  })

  it('refuses to install outside Linux', async () => {
    const output = await runAppIndicatorCommand({ argv: ['install', '--dir', target], platformName: 'darwin' })
    expect(output).toContain('Linux-only')
  })

  it('reports missing bindings clearly', async () => {
    const output = await runAppIndicatorCommand({
      argv: ['install', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      bindingsAvailable: false
    })
    expect(output).toContain('Missing GNOME AppIndicator Python bindings')
  })

  it('install creates helper and autostart entry', async () => {
    const output = await runAppIndicatorCommand({
      argv: ['install', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      commandRunner: noOpRunner,
      indicatorStarter: noOpStarter,
      bindingsAvailable: true
    })
    expect(output).toContain('installed GNOME top-bar indicator')
    const linked = await readlink(join(target, 'viberelay-appindicator.py'))
    expect(linked).toMatch(/viberelay-appindicator\.py$/)
    const desktopEntry = await readFile(join(autostart, 'viberelay-appindicator.desktop'), 'utf8')
    expect(desktopEntry).toContain(`Exec=python3 ${join(target, 'viberelay-appindicator.py')}`)
  })

  it('status reports installed state', async () => {
    await runAppIndicatorCommand({
      argv: ['install', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      commandRunner: noOpRunner,
      indicatorStarter: noOpStarter,
      bindingsAvailable: true
    })
    const output = await runAppIndicatorCommand({
      argv: ['status', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      commandRunner: async (cmd) => cmd === 'pgrep'
        ? { code: 0, stdout: `123 ${join(target, 'viberelay-appindicator.py')}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' }
    })
    expect(output).toContain('installed: yes')
    expect(output).toContain('running: yes')
  })

  it('status reports partial installs', async () => {
    await runAppIndicatorCommand({
      argv: ['install', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      commandRunner: noOpRunner,
      indicatorStarter: noOpStarter,
      bindingsAvailable: true
    })
    await rm(join(autostart, 'viberelay-appindicator.desktop'))
    const output = await runAppIndicatorCommand({
      argv: ['status', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      commandRunner: noOpRunner
    })
    expect(output).toContain('installed: partial')
    expect(output).toContain('missing: viberelay-appindicator.desktop')
  })

  it('rejects missing --dir value', async () => {
    await expect(runAppIndicatorCommand({ argv: ['install', '--dir'], platformName: 'linux' })).rejects.toThrow(/Missing value for --dir/)
  })

  it('uninstall removes helper and autostart entry', async () => {
    await runAppIndicatorCommand({
      argv: ['install', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      commandRunner: noOpRunner,
      indicatorStarter: noOpStarter,
      bindingsAvailable: true
    })
    const output = await runAppIndicatorCommand({
      argv: ['uninstall', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      commandRunner: noOpRunner
    })
    expect(output).toContain('removed GNOME top-bar indicator files')
    const status = await runAppIndicatorCommand({
      argv: ['status', '--dir', target],
      platformName: 'linux',
      autostartDir: autostart,
      commandRunner: noOpRunner
    })
    expect(status).toContain('installed: no')
  })

  it('rejects unknown subcommand', async () => {
    await expect(runAppIndicatorCommand({ argv: ['bogus'], platformName: 'linux' })).rejects.toThrow(/Unknown appindicator/)
  })
})
