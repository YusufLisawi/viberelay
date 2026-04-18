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

describe('dashboard ux', () => {
  it('renders summary strip, badges, actions, and empty-state guidance', async () => {
    const authDir = await mkdtemp(join(tmpdir(), 'viberelay-dashboard-ux-'))
    tempDirs.push(authDir)
    await mkdir(authDir, { recursive: true })

    await writeFile(join(authDir, 'claude-active.json'), JSON.stringify({
      type: 'claude',
      email: 'active@example.com'
    }))

    const controller = createDaemonController({
      port: 0,
      authDir,
      modelGroups: [{ id: 'g1', name: 'high', models: ['claude'], enabled: true }]
    })
    controllers.push(controller)

    const started = await controller.start()
    const response = await fetch(`http://${started.host}:${started.port}/dashboard`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Summary')
    expect(html).toContain('status-badge')
    expect(html).toContain('Running')
    expect(html).toContain('Utility')
    expect(html).toContain('/status')
    expect(html).toContain('/accounts')
    expect(html).toContain('/usage')
    expect(html).toContain('/v1/models')
    expect(html).toContain('No usage yet')
    expect(html).toContain('unused yet')
    expect(html).toContain('active@example.com')
    expect(html).toContain('<style>')
  })
})
