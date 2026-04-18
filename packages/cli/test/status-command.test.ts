import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonController } from '../../daemon/src/index.js'
import { runStatusCommand } from '../src/commands/status.js'

const controllers: ReturnType<typeof createDaemonController>[] = []
const tempDirs: string[] = []

afterEach(async () => {
  while (controllers.length > 0) {
    const controller = controllers.pop()
    if (controller) {
      await controller.stop()
    }
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop()
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

describe('status command', () => {
  it('prints normalized running state from daemon api', async () => {
    const authDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-auth-'))
    tempDirs.push(authDir)

    const controller = createDaemonController({ port: 0, authDir })
    const started = await controller.start()
    controllers.push(controller)

    const output = await runStatusCommand({
      baseUrl: `http://${started.host}:${started.port}`
    })

    expect(output).toContain('running')
    expect(output).toContain(String(started.port))
    expect(output).toContain('accounts 0/0')
  })
})
