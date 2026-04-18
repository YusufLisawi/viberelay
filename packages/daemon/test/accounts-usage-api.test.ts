import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonController } from '../src/index.js'

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

describe('accounts and usage api', () => {
  it('returns accounts summary and zeroed usage payload', async () => {
    const authDir = await mkdtemp(join(tmpdir(), 'viberelay-accounts-'))
    tempDirs.push(authDir)
    await mkdir(authDir, { recursive: true })

    await writeFile(join(authDir, 'claude-active.json'), JSON.stringify({
      type: 'claude',
      email: 'active@example.com'
    }))

    const controller = createDaemonController({ port: 0, authDir })
    controllers.push(controller)

    const started = await controller.start()
    const accountsResponse = await fetch(`http://${started.host}:${started.port}/accounts`)
    const usageResponse = await fetch(`http://${started.host}:${started.port}/usage`)
    const accounts = await accountsResponse.json() as {
      total: number
      active: number
      expired: number
      providers: Record<string, { accounts: Array<{ display_name: string }> }>
    }
    const usage = await usageResponse.json() as {
      total_requests: number
      endpoint_counts: Record<string, number>
      provider_counts: Record<string, number>
      model_counts: Record<string, number>
    }

    expect(accountsResponse.status).toBe(200)
    expect(accounts).toMatchObject({ total: 1, active: 1, expired: 0 })
    expect(accounts.providers.claude.accounts[0].display_name).toBe('active@example.com')

    expect(usageResponse.status).toBe(200)
    expect(usage.total_requests).toBe(0)
    expect(usage.endpoint_counts).toEqual({})
    expect(usage.provider_counts).toEqual({})
    expect(usage.model_counts).toEqual({})
  })
})
