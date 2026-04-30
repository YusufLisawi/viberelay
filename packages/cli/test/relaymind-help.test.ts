/**
 * Smoke tests: every `relaymind <verb> --help` must return a help string
 * containing the verb name and must NOT throw or trigger side effects.
 *
 * Each test runs in a temporary directory to avoid touching the real
 * `.relaymind/` directory.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runRelaymindCommand } from '../src/commands/relaymind/index.js'

const BASE_URL = 'http://x'

// All verbs that must support --help / -h / help
const VERBS = [
  'init',
  'setup',
  'doctor',
  'start',
  'stop',
  'restart',
  'status',
  'logs',
  'mem',
  'checkpoint',
  'daily',
  'context',
  'telegram',
  'self',
  'watchdog',
  'plugin',
] as const

let workspace: string
let originalCwd: string

beforeEach(async () => {
  originalCwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-help-'))
  process.chdir(workspace)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(workspace, { recursive: true, force: true })
})

describe('relaymind --help short-circuit', () => {
  for (const verb of VERBS) {
    describe(`relaymind ${verb}`, () => {
      it(`--help returns help text containing "${verb}"`, async () => {
        const out = await runRelaymindCommand({ argv: [verb, '--help'], baseUrl: BASE_URL })
        expect(typeof out).toBe('string')
        expect(out).toContain(verb)
      })

      it(`-h returns help text containing "${verb}"`, async () => {
        const out = await runRelaymindCommand({ argv: [verb, '-h'], baseUrl: BASE_URL })
        expect(typeof out).toBe('string')
        expect(out).toContain(verb)
      })

      it(`help (no dashes) returns help text containing "${verb}"`, async () => {
        const out = await runRelaymindCommand({ argv: [verb, 'help'], baseUrl: BASE_URL })
        expect(typeof out).toBe('string')
        expect(out).toContain(verb)
      })
    })
  }
})

describe('relaymind top-level help', () => {
  it('bare argv [] returns top-level help', async () => {
    const out = await runRelaymindCommand({ argv: [], baseUrl: BASE_URL })
    expect(typeof out).toBe('string')
    expect(out).toContain('RelayMind')
  })

  it('--help returns top-level help', async () => {
    const out = await runRelaymindCommand({ argv: ['--help'], baseUrl: BASE_URL })
    expect(typeof out).toBe('string')
    expect(out).toContain('RelayMind')
  })

  it('-h returns top-level help', async () => {
    const out = await runRelaymindCommand({ argv: ['-h'], baseUrl: BASE_URL })
    expect(typeof out).toBe('string')
    expect(out).toContain('RelayMind')
  })

  it('help returns top-level help', async () => {
    const out = await runRelaymindCommand({ argv: ['help'], baseUrl: BASE_URL })
    expect(typeof out).toBe('string')
    expect(out).toContain('RelayMind')
  })

  it('all top-level help invocations return the same string', async () => {
    const bare = await runRelaymindCommand({ argv: [], baseUrl: BASE_URL })
    const dashDash = await runRelaymindCommand({ argv: ['--help'], baseUrl: BASE_URL })
    const dash = await runRelaymindCommand({ argv: ['-h'], baseUrl: BASE_URL })
    const word = await runRelaymindCommand({ argv: ['help'], baseUrl: BASE_URL })
    expect(dashDash).toBe(bare)
    expect(dash).toBe(bare)
    expect(word).toBe(bare)
  })

  it('shows equivalent binary forms at the bottom', async () => {
    const out = await runRelaymindCommand({ argv: [], baseUrl: BASE_URL })
    expect(out).toContain('viberelay relaymind')
    expect(out).toContain('relaymind')
  })
})

describe('relaymind init --help does NOT create a profile', () => {
  it('--help returns string without creating .relaymind directory', async () => {
    const { access } = await import('node:fs/promises')
    const out = await runRelaymindCommand({ argv: ['init', '--help'], baseUrl: BASE_URL })
    expect(typeof out).toBe('string')
    expect(out).toContain('init')
    // .relaymind directory must not exist
    await expect(access(join(workspace, '.relaymind'))).rejects.toThrow()
  })

  it('-h returns string without creating .relaymind directory', async () => {
    const { access } = await import('node:fs/promises')
    const out = await runRelaymindCommand({ argv: ['init', '-h'], baseUrl: BASE_URL })
    expect(typeof out).toBe('string')
    expect(out).toContain('init')
    await expect(access(join(workspace, '.relaymind'))).rejects.toThrow()
  })

  it('help (no dashes) returns string without creating .relaymind directory', async () => {
    const { access } = await import('node:fs/promises')
    const out = await runRelaymindCommand({ argv: ['init', 'help'], baseUrl: BASE_URL })
    expect(typeof out).toBe('string')
    expect(out).toContain('init')
    await expect(access(join(workspace, '.relaymind'))).rejects.toThrow()
  })
})
