/**
 * Tests for the Telegram bridge worker.
 *
 * These exercise tickBridge with injected spawn/fetch and verify:
 *   - the exact `viberelay run -- --print --resume ...` argv shape
 *   - the Bot API URL + JSON body
 *   - file movement to processed/ on success and failed/ + .err on failure
 *   - skipped messages already in processed/ or failed/
 *   - pid lifecycle (start writes pid, stop removes it)
 *   - foreground SIGTERM cleanup (covered via aborted signal)
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { relayMindPaths } from '@viberelay/shared/relaymind'
import {
  getBridgeStatus,
  startBridge,
  stopBridge,
  tickBridge,
  type FetchFn,
  type SpawnFn,
} from '../src/lib/telegram-bridge.js'

let workspace: string
let cwd: string

beforeEach(async () => {
  cwd = process.cwd()
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-bridge-'))
  process.chdir(workspace)
})

afterEach(async () => {
  process.chdir(cwd)
  await rm(workspace, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function paths() {
  return relayMindPaths(workspace)
}

async function seedFixtures(opts: {
  profileName?: string | null
  sessionId?: string | null
} = {}): Promise<void> {
  const p = paths()
  await mkdir(p.supervisorStateDir, { recursive: true })
  await mkdir(p.stateRoot, { recursive: true })

  if (opts.profileName !== null) {
    await writeFile(
      p.configJson,
      JSON.stringify({ viberelayProfile: { name: opts.profileName ?? 'default' } }),
      'utf8',
    )
  }
  if (opts.sessionId !== null) {
    await writeFile(
      p.sessionFile,
      JSON.stringify({
        sessionName: 'relaymind-main',
        claudeSessionId: opts.sessionId ?? 'sess-abc-123',
        pid: 0,
        startedAt: new Date().toISOString(),
        status: 'running',
      }),
      'utf8',
    )
  }
}

async function writeMirror(name: string, content: string, meta: Record<string, string>): Promise<string> {
  const p = paths()
  const dir = join(p.telegramStateDir, 'messages')
  await mkdir(dir, { recursive: true })
  const target = join(dir, name)
  await writeFile(target, JSON.stringify({ content, meta }), 'utf8')
  return target
}

describe('tickBridge — happy path', () => {
  it('spawns viberelay run -- --print --resume with the right argv and env, then POSTs to Bot API', async () => {
    await seedFixtures()
    await writeMirror('7.1700000000000.json', 'hello from telegram', {
      chat_id: '42',
      message_id: '7',
      user: 'yusup',
      user_id: '99',
      ts: '2026-04-27T12:00:00.000Z',
    })

    const spawnCalls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const spawnFn: SpawnFn = async (command, args, opts) => {
      spawnCalls.push({ command, args, env: opts.env })
      return { code: 0, stdout: 'hi yusup, masha2Allah\n', stderr: '' }
    }

    const fetchCalls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn: FetchFn = async (url, init) => {
      fetchCalls.push({ url, init })
      return { ok: true, status: 200, text: async () => '{"ok":true}' }
    }

    const result = await tickBridge(paths(), {
      botToken: 'TEST_TOKEN',
      viberelayBin: '/usr/local/bin/viberelay',
      spawnFn,
      fetchFn,
    })

    expect(result.status).toBe('processed')
    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]!
    expect(call.command).toBe('/usr/local/bin/viberelay')
    expect(call.args).toEqual([
      'run', '-d', 'default', '--',
      '--print', '--resume', 'sess-abc-123',
      '--append-system-prompt', '[Telegram message from chat 42 user yusup]',
      '--output-format', 'text',
      'hello from telegram',
    ])
    expect(call.env.TELEGRAM_DISABLE_POLL).toBe('1')
    expect(call.env.TELEGRAM_BOT_TOKEN).toBe('TEST_TOKEN')
    expect(call.env.TELEGRAM_STATE_DIR).toBe(paths().telegramStateDir)

    expect(fetchCalls).toHaveLength(1)
    const fc = fetchCalls[0]!
    expect(fc.url).toBe('https://api.telegram.org/botTEST_TOKEN/sendMessage')
    expect(fc.init.method).toBe('POST')
    const body = JSON.parse(fc.init.body as string) as Record<string, unknown>
    expect(body.chat_id).toBe('42')
    expect(body.text).toBe('hi yusup, masha2Allah')
    expect(body.reply_to_message_id).toBe(7)

    // File moved to processed/
    const procDir = join(paths().telegramStateDir, 'messages', 'processed')
    const proc = await readdir(procDir)
    expect(proc).toContain('7.1700000000000.json')
    // No leftover in messages/
    const top = await readdir(join(paths().telegramStateDir, 'messages'))
    expect(top.filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })
})

describe('tickBridge — failure path', () => {
  it('moves to failed/ with .err sibling on non-zero exit', async () => {
    await seedFixtures()
    await writeMirror('5.1700000000000.json', 'will fail', {
      chat_id: '1', message_id: '5', user: 'u', user_id: '1', ts: 't',
    })

    const spawnFn: SpawnFn = async () => ({ code: 2, stdout: '', stderr: 'boom: claude crashed' })
    const fetchFn: FetchFn = async () => ({ ok: true, status: 200, text: async () => '' })

    const r = await tickBridge(paths(), { botToken: 'TOK', spawnFn, fetchFn })
    expect(r.status).toBe('failed')

    const failedRoot = join(paths().telegramStateDir, 'messages', 'failed')
    const items = await readdir(failedRoot)
    expect(items).toContain('5.1700000000000.json')
    expect(items).toContain('5.1700000000000.json.err')
    const errBody = await readFile(join(failedRoot, '5.1700000000000.json.err'), 'utf8')
    expect(errBody).toContain('boom: claude crashed')
  })

  it('moves to failed/ when sendMessage returns non-2xx', async () => {
    await seedFixtures()
    await writeMirror('9.1700000000000.json', 'bot api will reject', {
      chat_id: '1', message_id: '9', user: 'u', user_id: '1', ts: 't',
    })

    const spawnFn: SpawnFn = async () => ({ code: 0, stdout: 'reply', stderr: '' })
    const fetchFn: FetchFn = async () => ({ ok: false, status: 401, text: async () => '{"description":"Unauthorized"}' })

    const r = await tickBridge(paths(), { botToken: 'TOK', spawnFn, fetchFn })
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('http=401')
  })
})

describe('tickBridge — misconfigured', () => {
  it('returns misconfigured when TELEGRAM_BOT_TOKEN is unset', async () => {
    await seedFixtures()
    const saved = process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    try {
      const r = await tickBridge(paths(), {})
      expect(r.status).toBe('misconfigured')
      expect(r.reason).toContain('TELEGRAM_BOT_TOKEN')
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved
    }
  })

  it('returns misconfigured when no profile is configured', async () => {
    await seedFixtures({ profileName: null })
    const r = await tickBridge(paths(), { botToken: 'TOK' })
    expect(r.status).toBe('misconfigured')
    expect(r.reason).toContain('profile')
  })

  it('returns misconfigured when no claudeSessionId is recorded', async () => {
    await seedFixtures({ sessionId: null })
    const r = await tickBridge(paths(), { botToken: 'TOK' })
    expect(r.status).toBe('misconfigured')
    expect(r.reason).toContain('claudeSessionId')
  })

  it('returns idle when there are no pending mirror files', async () => {
    await seedFixtures()
    const r = await tickBridge(paths(), { botToken: 'TOK' })
    expect(r.status).toBe('idle')
  })
})

describe('tickBridge — does not re-process', () => {
  it('skips files already in processed/ and failed/', async () => {
    await seedFixtures()
    const p = paths()
    const procDir = join(p.telegramStateDir, 'messages', 'processed')
    const failDir = join(p.telegramStateDir, 'messages', 'failed')
    await mkdir(procDir, { recursive: true })
    await mkdir(failDir, { recursive: true })
    await writeFile(join(procDir, 'old-success.json'), '{}', 'utf8')
    await writeFile(join(failDir, 'old-fail.json'), '{}', 'utf8')

    const spawnFn: SpawnFn = vi.fn(async () => ({ code: 0, stdout: 'x', stderr: '' }))
    const fetchFn: FetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))

    const r = await tickBridge(p, { botToken: 'TOK', spawnFn, fetchFn })
    expect(r.status).toBe('idle')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('pid lifecycle', () => {
  it('startBridge --foreground with a pre-aborted signal returns and cleans pid', async () => {
    await seedFixtures()
    const p = paths()
    const ac = new AbortController()
    ac.abort()

    await startBridge(p, { foreground: true, signal: ac.signal })

    const pidPath = join(p.supervisorStateDir, 'bridge.pid')
    await expect(stat(pidPath)).rejects.toThrow()

    const log = await readFile(join(p.supervisorStateDir, 'bridge.log'), 'utf8')
    expect(log).toContain('bridge foreground started')
  })

  it('stopBridge returns not-running when no pid file exists', async () => {
    const r = await stopBridge(paths())
    expect(r.stopped).toBe(false)
    expect(r.pid).toBeNull()
  })

  it('stopBridge cleans up a stale pid file', async () => {
    const p = paths()
    await mkdir(p.supervisorStateDir, { recursive: true })
    await writeFile(join(p.supervisorStateDir, 'bridge.pid'), '999999999\n', 'utf8')
    const r = await stopBridge(p)
    expect(r.stopped).toBe(false)
    expect(r.pid).toBe(999999999)
    await expect(stat(join(p.supervisorStateDir, 'bridge.pid'))).rejects.toThrow()
  })

  it('getBridgeStatus reports not-running when no pid', async () => {
    const s = await getBridgeStatus(paths())
    expect(s.running).toBe(false)
    expect(s.pid).toBeNull()
    expect(s.processedCount).toBe(0)
  })
})

describe('foreground exits cleanly on SIGTERM-equivalent abort', () => {
  it('the loop returns when the abort signal fires after startup', async () => {
    await seedFixtures()
    const p = paths()
    const ac = new AbortController()

    const loop = startBridge(p, {
      foreground: true,
      signal: ac.signal,
      pollIntervalMs: 30,
      botToken: 'TOK',
      spawnFn: async () => ({ code: 0, stdout: '', stderr: '' }),
      fetchFn: async () => ({ ok: true, status: 200, text: async () => '' }),
    })

    await new Promise((r) => setTimeout(r, 60))
    ac.abort()
    await loop

    await expect(stat(join(p.supervisorStateDir, 'bridge.pid'))).rejects.toThrow()
  })
})
