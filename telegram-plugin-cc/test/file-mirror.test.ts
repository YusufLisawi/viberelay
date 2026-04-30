/**
 * File-mirror + DISABLE_POLL gate tests.
 *
 * server.ts has top-level side effects (env load, Bot construction, polling),
 * so we test the file-mirror via the exported `mirrorInboundMessage` helper
 * — which is a pure function — and verify the DISABLE_POLL gate by spawning
 * server.ts in a subprocess and observing stderr.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mirrorInboundMessage } from '../file-mirror.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'telegram-mirror-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('mirrorInboundMessage', () => {
  it('writes a JSON file with content + meta under <root>/messages/', () => {
    const target = mirrorInboundMessage(tmp, 'hello world', {
      chat_id: '42',
      message_id: '7',
      user: 'yusup',
      user_id: '99',
      ts: '2026-04-27T12:00:00.000Z',
    })

    expect(target.startsWith(join(tmp, 'messages'))).toBe(true)
    const raw = readFileSync(target, 'utf8')
    const parsed = JSON.parse(raw) as { content: string; meta: Record<string, string> }
    expect(parsed.content).toBe('hello world')
    expect(parsed.meta.chat_id).toBe('42')
    expect(parsed.meta.message_id).toBe('7')
    expect(parsed.meta.user).toBe('yusup')
    expect(parsed.meta.user_id).toBe('99')
    expect(parsed.meta.ts).toBe('2026-04-27T12:00:00.000Z')
  })

  it('uses message_id in the filename so the bridge can sort by id', () => {
    mirrorInboundMessage(tmp, 'a', {
      chat_id: '1', message_id: '5', user: 'u', user_id: '1', ts: 'now',
    })
    const files = readdirSync(join(tmp, 'messages'))
    expect(files).toHaveLength(1)
    expect(files[0].startsWith('5.')).toBe(true)
    expect(files[0].endsWith('.json')).toBe(true)
  })

  it('writes atomically (no .tmp left behind on success)', () => {
    mirrorInboundMessage(tmp, 'x', {
      chat_id: '1', message_id: '1', user: 'u', user_id: '1', ts: 'now',
    })
    const files = readdirSync(join(tmp, 'messages'))
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
  })

  it('preserves attachment fields when present', () => {
    const target = mirrorInboundMessage(tmp, 'caption', {
      chat_id: '1', message_id: '2', user: 'u', user_id: '1', ts: 'now',
      attachment_kind: 'photo',
      attachment_file_id: 'ABC',
      attachment_mime: 'image/jpeg',
    })
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      meta: { attachment_kind: string; attachment_file_id: string; attachment_mime: string }
    }
    expect(parsed.meta.attachment_kind).toBe('photo')
    expect(parsed.meta.attachment_file_id).toBe('ABC')
    expect(parsed.meta.attachment_mime).toBe('image/jpeg')
  })
})

describe('TELEGRAM_DISABLE_POLL gate', () => {
  it('does not call bot.start() — stderr says polling disabled', async () => {
    // Build the env that lets server.ts boot far enough to print the gate
    // banner without performing any network I/O. We point STATE_DIR to a
    // throwaway tmp so the mkdir + pid file writes are isolated, and we
    // pass a syntactically-valid token so the early "TELEGRAM_BOT_TOKEN
    // required" abort does not trigger.
    const stateDir = join(tmp, 'state')
    mkdirSync(stateDir, { recursive: true })
    // Pre-create .env so the chmod path is happy (it's wrapped in try/catch
    // anyway, but defensive).
    writeFileSync(join(stateDir, '.env'), '', 'utf8')

    const serverPath = join(__dirname, '..', 'server.ts')

    const child = spawn('bun', [serverPath], {
      env: {
        ...process.env,
        TELEGRAM_STATE_DIR: stateDir,
        TELEGRAM_BOT_TOKEN: '0:fake-token-for-test',
        TELEGRAM_DISABLE_POLL: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    // Wait up to 4s for the banner. We deliberately do not send any MCP
    // initialize request — the server prints the polling-disabled banner
    // synchronously at boot, before MCP initialization.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 4000)
      child.stderr.on('data', () => {
        if (stderr.includes('polling disabled')) {
          clearTimeout(t)
          resolve()
        }
      })
    })

    child.kill('SIGTERM')
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    expect(stderr).toContain('polling disabled')
    // It must NOT have started polling — i.e. no "polling as @" success line
    // and no 409 Conflict (the fake token would 401 immediately if polling).
    expect(stderr).not.toMatch(/polling as @/)
  }, 10_000)
})
