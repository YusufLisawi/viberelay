import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe('dashboard portal actions', () => {
  it('renders provider toggle form and model group editor form', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'viberelay-dashboard-portal-'))
    tempDirs.push(stateDir)

    const controller = createDaemonController({
      port: 0,
      stateDir,
      providerEnabled: { anthropic: true },
      modelGroups: [{ id: 'g1', name: 'high', models: ['anthropic/claude-sonnet-4-5'], enabled: true }]
    })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/dashboard`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Provider Controls')
    expect(html).toContain('name="provider"')
    expect(html).toContain('name="enabled"')
    expect(html).toContain('Model Group Editor')
    expect(html).toContain('name="groupId"')
    expect(html).toContain('name="groupName"')
    expect(html).toContain('name="groupModels"')
  })

  it('renders account actions, multi-provider controls, and group delete controls', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'viberelay-dashboard-portal-rich-'))
    tempDirs.push(stateDir)
    const authDir = await mkdtemp(join(tmpdir(), 'viberelay-dashboard-auth-'))
    tempDirs.push(authDir)

    await writeFile(join(authDir, 'anthropic-primary.json'), JSON.stringify({
      type: 'anthropic',
      email: 'user@example.com'
    }))

    const controller = createDaemonController({
      port: 0,
      stateDir,
      authDir,
      providerEnabled: { anthropic: true, openai: false },
      modelGroups: [{ id: 'g1', name: 'high', models: ['anthropic/claude-sonnet-4-5'], enabled: true }]
    })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/dashboard`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Enable openai')
    expect(html).toContain('Disable anthropic')
    expect(html).toContain('Account Actions')
    expect(html).toContain('name="accountFile"')
    expect(html).toContain('Disable account')
    expect(html).toContain('Remove group')
    expect(html).toContain('name="enabled" value="true"')
    expect(html).toContain('name="enabled" value="false"')
  })
})
