import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { relayMindPaths } from '@viberelay/shared/relaymind'
import init from '../src/commands/relaymind/init.js'
import self from '../src/commands/relaymind/self.js'

let workspace: string
let originalCwd: string
let originalPath: string | undefined

beforeEach(async () => {
  originalCwd = process.cwd()
  originalPath = process.env.PATH
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-self-'))
  process.chdir(workspace)
  const binDir = join(workspace, 'bin')
  await mkdir(binDir, { recursive: true })
  for (const bin of ['tmux', 'claude']) {
    const binPath = join(binDir, bin)
    await writeFile(binPath, '#!/bin/sh\necho "$0 test-version"\n', 'utf8')
    await chmod(binPath, 0o755)
  }
  process.env.PATH = `${binDir}:${originalPath ?? ''}`
})

afterEach(async () => {
  process.chdir(originalCwd)
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  await rm(workspace, { recursive: true, force: true })
})

describe('relaymind self', () => {
  it('snapshot then rollback round-trips registry.json', async () => {
    await init([])
    const paths = relayMindPaths(workspace)

    const snapOut = await self(['snapshot'])
    expect(snapOut).toContain('snapshot written')

    const original = await readFile(paths.registryJson, 'utf8')
    await writeFile(paths.registryJson, '{"commands": [{"name":"mutated","description":"x","mode":"direct","handler":"x"}]}', 'utf8')

    const rollOut = await self(['rollback'])
    expect(rollOut).toContain('restored')
    expect(await readFile(paths.registryJson, 'utf8')).toBe(original)
  })

  it('rollback throws when no snapshot exists (PRD §867)', async () => {
    await init([])
    await expect(self(['rollback'])).rejects.toThrow(/cannot rollback — no last-good registry/)
  })

  it('validate FAILs and surfaces detail when a required file is missing', async () => {
    await init([])
    const paths = relayMindPaths(workspace)
    await rm(paths.memoryMd)
    const out = await self(['validate'])
    expect(out).toContain('FAIL')
    expect(out).toContain('verifyInstallation')
    expect(out).toContain('MEMORY.md')
  })

  it('help is printed when no subcommand is given', async () => {
    const out = await self([])
    expect(out).toContain('viberelay relaymind self')
    expect(out).toContain('validate')
    expect(out).toContain('snapshot')
    expect(out).toContain('rollback')
  })
})
