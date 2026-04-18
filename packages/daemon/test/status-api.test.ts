import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonController } from '../src/index.js'

interface StatusPayload {
  generated_at: string
  proxy: {
    host: string
    port: number
    target_port: number
    running: boolean
  }
  model_groups: {
    last_hit_by_group_id: Record<string, string>
  }
  accounts: {
    total: number
    active: number
    expired: number
    providers: Record<string, {
      accounts: Array<{ display_name: string }>
    }>
  }
}

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

describe('status api', () => {
  it('returns root-inspired proxy and accounts summary payload', async () => {
    const authDir = await mkdtemp(join(tmpdir(), 'viberelay-auth-'))
    tempDirs.push(authDir)
    await mkdir(authDir, { recursive: true })

    await writeFile(join(authDir, 'claude-active.json'), JSON.stringify({
      type: 'claude',
      email: 'active@example.com'
    }))

    await writeFile(join(authDir, 'codex-expired.json'), JSON.stringify({
      type: 'codex',
      login: 'expired-user',
      expired: '2024-01-01T00:00:00Z'
    }))

    const controller = createDaemonController({ port: 0, authDir })
    controllers.push(controller)

    const started = await controller.start()
    const response = await fetch(`http://${started.host}:${started.port}/status`)
    const payload = await response.json() as StatusPayload

    expect(response.status).toBe(200)
    expect(payload.proxy).toMatchObject({
      host: '127.0.0.1',
      port: started.port,
      target_port: 8328,
      running: true
    })
    expect(payload.accounts).toMatchObject({
      total: 2,
      active: 1,
      expired: 1
    })
    expect(payload.accounts.providers.claude.accounts[0].display_name).toBe('active@example.com')
    expect(payload.accounts.providers.codex.accounts[0].display_name).toBe('expired-user')
    expect(payload.model_groups.last_hit_by_group_id).toEqual({})
    expect(typeof payload.generated_at).toBe('string')
  })
})
