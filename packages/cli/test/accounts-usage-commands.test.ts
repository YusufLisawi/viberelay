import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonController } from '../../daemon/src/index.js'
import { runAccountsCommand } from '../src/commands/accounts.js'
import { runUsageCommand } from '../src/commands/usage.js'

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

describe('accounts and usage commands', () => {
  it('prints normalized account and usage summaries', async () => {
    const authDir = await mkdtemp(join(tmpdir(), 'viberelay-cli-accounts-'))
    tempDirs.push(authDir)
    await mkdir(authDir, { recursive: true })

    await writeFile(join(authDir, 'claude-active.json'), JSON.stringify({
      type: 'claude',
      email: 'active@example.com'
    }))

    const controller = createDaemonController({ port: 0, authDir })
    controllers.push(controller)
    const started = await controller.start()
    const baseUrl = `http://${started.host}:${started.port}`

    const accountsOutput = await runAccountsCommand({ baseUrl })
    const usageOutput = await runUsageCommand({ baseUrl })

    expect(accountsOutput).toContain('claude')
    expect(accountsOutput).toContain('1/1 active')
    expect(usageOutput).toContain('requests 0')
  })
})
