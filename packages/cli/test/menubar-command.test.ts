import { mkdtemp, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMenubarCommand } from '../src/commands/menubar.js'

let target: string

beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), 'viberelay-menubar-'))
})

afterEach(async () => {
  await rm(target, { recursive: true, force: true })
})

describe('menubar command', () => {
  it('prints usage when no subcommand', async () => {
    const output = await runMenubarCommand({ argv: [] })
    expect(output).toContain('viberelay menubar <command>')
    expect(output).toContain('install')
  })

  it('install creates a symlink in the target dir', async () => {
    if (process.platform !== 'darwin') return
    const output = await runMenubarCommand({ argv: ['install', '--dir', target] })
    expect(output).toContain('installed viberelay.5s.sh')
    const linked = await readlink(join(target, 'viberelay.5s.sh'))
    expect(linked).toMatch(/viberelay\.5s\.sh$/)
  })

  it('uninstall removes the symlink', async () => {
    if (process.platform !== 'darwin') return
    await runMenubarCommand({ argv: ['install', '--dir', target] })
    const output = await runMenubarCommand({ argv: ['uninstall', '--dir', target] })
    expect(output).toContain('removed')
  })

  it('status reports installed state', async () => {
    if (process.platform !== 'darwin') return
    await runMenubarCommand({ argv: ['install', '--dir', target] })
    const output = await runMenubarCommand({ argv: ['status', '--dir', target] })
    expect(output).toContain('installed: yes')
  })

  it('status reports absent when plugin not installed', async () => {
    if (process.platform !== 'darwin') return
    const output = await runMenubarCommand({ argv: ['status', '--dir', target] })
    expect(output).toContain('installed: no')
  })

  it('install overwrites an existing symlink', async () => {
    if (process.platform !== 'darwin') return
    const fake = join(target, 'viberelay.5s.sh')
    await writeFile(fake, '#!/bin/sh\necho old\n')
    const output = await runMenubarCommand({ argv: ['install', '--dir', target] })
    expect(output).toContain('installed')
    const linked = await readlink(fake)
    expect(linked).toMatch(/viberelay\.5s\.sh$/)
  })

  it('rejects unknown subcommand', async () => {
    if (process.platform !== 'darwin') return
    await expect(runMenubarCommand({ argv: ['bogus'] })).rejects.toThrow(/Unknown menubar/)
  })
})
