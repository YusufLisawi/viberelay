import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  dispatchViaCli,
  type BinaryTarget,
  type TelegramCliRequest,
} from '../cli-bridge.js'

interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: (signal?: NodeJS.Signals | number) => boolean
  killed: boolean
}

interface FakeRun {
  stdout?: string
  stderr?: string
  exitCode?: number
  delayMs?: number
  /** Throw from spawn() itself (e.g. ENOENT). */
  spawnError?: Error
  /** Never close — used to exercise timeout. */
  hang?: boolean
}

function makeSpawnImpl(run: FakeRun) {
  return ((..._args: unknown[]) => {
    if (run.spawnError) {
      // Real child_process.spawn emits 'error' asynchronously rather than
      // throwing; mirror that.
      const child = makeFakeChild()
      setImmediate(() => child.emit('error', run.spawnError))
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>
    }
    const child = makeFakeChild()
    const { stdout = '', stderr = '', exitCode = 0, delayMs = 0, hang = false } = run
    setTimeout(() => {
      if (stdout) child.stdout.write(stdout)
      if (stderr) child.stderr.write(stderr)
      if (!hang) {
        child.stdout.end()
        child.stderr.end()
        child.emit('close', exitCode)
      }
    }, delayMs)
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>
  }) as unknown as typeof import('node:child_process').spawn
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.stdout.end()
    child.stderr.end()
    setImmediate(() => child.emit('close', null))
    return true
  }
  return child
}

const target: BinaryTarget = { command: '/fake/viberelay', args: [] }
const resolveBinary = (): BinaryTarget => target

const baseRequest: TelegramCliRequest = {
  schemaVersion: 1,
  command: 'usage',
  args: '',
  chat: { id: '42' },
}

describe('dispatchViaCli', () => {
  it('returns parsed reply on the legacy { handled, text } shape', async () => {
    const reply = await dispatchViaCli(baseRequest, {
      resolveBinary,
      spawnImpl: makeSpawnImpl({ stdout: JSON.stringify({ handled: true, text: 'hello' }) }),
    })
    expect(reply).toEqual({ handled: true, text: 'hello' })
  })

  it('returns parsed reply on the legacy { handled, llmPrompt } shape', async () => {
    const reply = await dispatchViaCli(baseRequest, {
      resolveBinary,
      spawnImpl: makeSpawnImpl({ stdout: JSON.stringify({ handled: true, llmPrompt: 'do it' }) }),
    })
    expect(reply).toEqual({ handled: true, llmPrompt: 'do it' })
  })

  it('returns { handled: false } when the CLI declines', async () => {
    const reply = await dispatchViaCli(baseRequest, {
      resolveBinary,
      spawnImpl: makeSpawnImpl({ stdout: JSON.stringify({ handled: false }) }),
    })
    expect(reply).toEqual({ handled: false })
  })

  it('normalizes the PRD { action: "reply" } shape', async () => {
    const reply = await dispatchViaCli(baseRequest, {
      resolveBinary,
      spawnImpl: makeSpawnImpl({
        stdout: JSON.stringify({ action: 'reply', text: 'hi', files: ['/tmp/a.png'] }),
      }),
    })
    expect(reply).toEqual({ handled: true, text: 'hi', files: ['/tmp/a.png'] })
  })

  it('normalizes the PRD { action: "forward-to-claude" } shape', async () => {
    const reply = await dispatchViaCli(baseRequest, {
      resolveBinary,
      spawnImpl: makeSpawnImpl({
        stdout: JSON.stringify({ action: 'forward-to-claude', prompt: 'go' }),
      }),
    })
    expect(reply).toEqual({ handled: true, llmPrompt: 'go' })
  })

  it('normalizes { action: "noop" } to { handled: false }', async () => {
    const reply = await dispatchViaCli(baseRequest, {
      resolveBinary,
      spawnImpl: makeSpawnImpl({ stdout: JSON.stringify({ action: 'noop' }) }),
    })
    expect(reply).toEqual({ handled: false })
  })

  it('throws when the CLI exits non-zero', async () => {
    await expect(
      dispatchViaCli(baseRequest, {
        resolveBinary,
        spawnImpl: makeSpawnImpl({ exitCode: 1, stderr: 'boom' }),
      }),
    ).rejects.toThrow(/boom/)
  })

  it('throws when the CLI emits malformed JSON', async () => {
    await expect(
      dispatchViaCli(baseRequest, {
        resolveBinary,
        spawnImpl: makeSpawnImpl({ stdout: 'not-json' }),
      }),
    ).rejects.toThrow(/malformed JSON/)
  })

  it('throws when the CLI returns empty stdout', async () => {
    await expect(
      dispatchViaCli(baseRequest, {
        resolveBinary,
        spawnImpl: makeSpawnImpl({ stdout: '' }),
      }),
    ).rejects.toThrow(/empty output/)
  })

  it('throws when the CLI hangs past the timeout', async () => {
    await expect(
      dispatchViaCli(baseRequest, {
        resolveBinary,
        spawnImpl: makeSpawnImpl({ hang: true }),
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timed out after 25ms/)
  })

  it('throws when spawn itself errors (missing binary)', async () => {
    await expect(
      dispatchViaCli(baseRequest, {
        resolveBinary,
        spawnImpl: makeSpawnImpl({ spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
      }),
    ).rejects.toThrow(/ENOENT/)
  })

  it('rejects unknown action values', async () => {
    await expect(
      dispatchViaCli(baseRequest, {
        resolveBinary,
        spawnImpl: makeSpawnImpl({ stdout: JSON.stringify({ action: 'launch-rocket' }) }),
      }),
    ).rejects.toThrow(/unknown action/)
  })
})
