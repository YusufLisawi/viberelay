/**
 * Integration test for the slash-command dispatch path.
 *
 * server.ts runs side effects at module top-level (loads env, instantiates
 * the grammy Bot), so we don't import it. Instead we exercise the load-bearing
 * boundary: dispatchViaCli + resolveViberelayBinary using a stub binary on
 * disk. This proves:
 *
 *   - the bridge spawns the resolved binary,
 *   - it pipes the request as stdin JSON,
 *   - it parses one line of stdout JSON,
 *   - exit-code failures throw (server.ts catches and falls back),
 *   - VIBERELAY_BIN routing works.
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dispatchViaCli,
  resolveViberelayBinary,
  type TelegramCliRequest,
} from '../cli-bridge.js'

const isWin = process.platform === 'win32'

let tmp: string
let savedBin: string | undefined
let savedTimeout: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'viberelay-bridge-'))
  savedBin = process.env.VIBERELAY_BIN
  savedTimeout = process.env.VIBERELAY_RELAYMIND_CLI_TIMEOUT_MS
})

afterEach(() => {
  if (savedBin === undefined) delete process.env.VIBERELAY_BIN
  else process.env.VIBERELAY_BIN = savedBin
  if (savedTimeout === undefined) delete process.env.VIBERELAY_RELAYMIND_CLI_TIMEOUT_MS
  else process.env.VIBERELAY_RELAYMIND_CLI_TIMEOUT_MS = savedTimeout
  rmSync(tmp, { recursive: true, force: true })
})

function writeStubBinary(reply: string, exitCode = 0): string {
  const path = join(tmp, isWin ? 'viberelay-stub.cmd' : 'viberelay-stub.sh')
  if (isWin) {
    // Skip on Windows — CI for this repo runs on linux/macOS. The test below
    // is gated by the platform check.
    writeFileSync(path, '@echo off\n')
  } else {
    // Read all stdin (drain), then echo the canned reply, then exit with code.
    const safeReply = reply.replace(/'/g, `'\\''`)
    writeFileSync(
      path,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${safeReply}'\nexit ${exitCode}\n`,
    )
    chmodSync(path, 0o755)
  }
  return path
}

const baseRequest: TelegramCliRequest = {
  schemaVersion: 1,
  command: 'usage',
  args: '',
  chat: { id: '42' },
}

describe('cli-bridge integration', () => {
  it.skipIf(isWin)('resolves VIBERELAY_BIN when set to an existing absolute path', () => {
    const stub = writeStubBinary(JSON.stringify({ handled: false }))
    process.env.VIBERELAY_BIN = stub
    const target = resolveViberelayBinary()
    expect(target.command).toBe(stub)
    expect(target.args).toEqual([])
  })

  it('rejects VIBERELAY_BIN with a relative path', () => {
    process.env.VIBERELAY_BIN = './viberelay'
    expect(() => resolveViberelayBinary()).toThrow(/absolute path/)
  })

  it('rejects VIBERELAY_BIN pointing at a missing file', () => {
    process.env.VIBERELAY_BIN = '/nonexistent/viberelay-xyz'
    expect(() => resolveViberelayBinary()).toThrow(/does not exist/)
  })

  it.skipIf(isWin)('round-trips a request through the resolved binary on success', async () => {
    const stub = writeStubBinary(JSON.stringify({ handled: true, text: 'ok' }))
    process.env.VIBERELAY_BIN = stub

    const reply = await dispatchViaCli(baseRequest)
    expect(reply).toEqual({ handled: true, text: 'ok' })
  })

  it.skipIf(isWin)('throws on non-zero exit so server.ts falls back to in-process', async () => {
    const stub = writeStubBinary('boom', 2)
    process.env.VIBERELAY_BIN = stub

    await expect(dispatchViaCli(baseRequest)).rejects.toThrow(/viberelay CLI failed/)
  })

  it.skipIf(isWin)('throws on malformed JSON so server.ts falls back to in-process', async () => {
    const stub = writeStubBinary('definitely not json')
    process.env.VIBERELAY_BIN = stub

    await expect(dispatchViaCli(baseRequest)).rejects.toThrow(/malformed JSON/)
  })

  it.skipIf(isWin)('honors VIBERELAY_RELAYMIND_CLI_TIMEOUT_MS via env', async () => {
    // A stub that hangs forever after reading stdin.
    const path = join(tmp, 'hang.sh')
    writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nsleep 30\n`)
    chmodSync(path, 0o755)
    process.env.VIBERELAY_BIN = path
    process.env.VIBERELAY_RELAYMIND_CLI_TIMEOUT_MS = '40'

    await expect(dispatchViaCli(baseRequest)).rejects.toThrow(/timed out after 40ms/)
  })
})
