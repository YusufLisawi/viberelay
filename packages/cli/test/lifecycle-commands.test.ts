import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDashboardCommand } from '../src/commands/dashboard.js'
import { runStartCommand } from '../src/commands/start.js'
import { runStatusCommand } from '../src/commands/status.js'
import { runStopCommand } from '../src/commands/stop.js'

let tempState: string
const originalEnv = { state: process.env.VIBERELAY_STATE_DIR, bin: process.env.VIBERELAY_DAEMON_BINARY }

beforeEach(async () => {
  tempState = await mkdtemp(join(tmpdir(), 'viberelay-cli-lifecycle-'))
  process.env.VIBERELAY_STATE_DIR = tempState
  process.env.VIBERELAY_DAEMON_BINARY = '/bin/sleep-fake-nonexistent-for-test'
})

afterEach(async () => {
  process.env.VIBERELAY_STATE_DIR = originalEnv.state
  process.env.VIBERELAY_DAEMON_BINARY = originalEnv.bin
  await rm(tempState, { recursive: true, force: true })
})

describe('lifecycle commands', () => {
  it('status reports not-running when daemon is down', async () => {
    const output = await runStatusCommand({ baseUrl: 'http://127.0.0.1:59999' })
    expect(output).toContain('not running')
  })

  it('stop is a no-op when no PID file exists', async () => {
    const output = await runStopCommand({ baseUrl: 'http://127.0.0.1:59999' })
    expect(output).toContain('not running')
  })

  it('start fails cleanly when daemon binary is missing', async () => {
    await expect(runStartCommand({ baseUrl: 'http://127.0.0.1:1', wait: false }))
      .rejects.toThrow(/ENOENT|no such file/i)
  })

  it('dashboard command uses injected opener', async () => {
    let captured = ''
    const output = await runDashboardCommand({
      baseUrl: 'http://127.0.0.1:8327',
      openUrl: async (url) => { captured = url }
    })
    expect(captured).toBe('http://127.0.0.1:8327/dashboard')
    expect(output).toContain('/dashboard')
  })
})
