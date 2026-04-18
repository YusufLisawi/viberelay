import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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

describe('settings portal mutations', () => {
  it('persists provider toggles and model group CRUD through dashboard api', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'viberelay-state-'))
    tempDirs.push(stateDir)

    const controller = createDaemonController({
      port: 0,
      stateDir,
      modelGroups: [{ id: 'g1', name: 'high', models: ['anthropic/claude-sonnet-4-5'], enabled: true }],
      providerEnabled: { anthropic: true }
    })
    controllers.push(controller)
    const started = await controller.start()

    const base = `http://${started.host}:${started.port}`

    await fetch(`${base}/relay/providers/anthropic/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    await fetch(`${base}/relay/model-groups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'g2', name: 'mid', models: ['openai/gpt-5.4'], enabled: true }) })
    await fetch(`${base}/relay/model-groups/g1`, { method: 'DELETE' })

    const settingsResponse = await fetch(`${base}/relay/settings-state`)
    const settings = await settingsResponse.json() as {
      providerEnabled: Record<string, boolean>
      modelGroups: Array<{ id: string, name: string }>
    }

    expect(settings.providerEnabled.anthropic).toBe(false)
    expect(settings.modelGroups.some((group) => group.id === 'g1')).toBe(false)
    expect(settings.modelGroups.some((group) => group.id === 'g2' && group.name === 'mid')).toBe(true)
  })

  it('accepts dashboard form submissions for provider and model group updates', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'viberelay-state-form-'))
    tempDirs.push(stateDir)

    const controller = createDaemonController({
      port: 0,
      stateDir,
      modelGroups: [{ id: 'g1', name: 'high', models: ['anthropic/claude-sonnet-4-5'], enabled: true }],
      providerEnabled: { anthropic: true, openai: false }
    })
    controllers.push(controller)
    const started = await controller.start()

    const base = `http://${started.host}:${started.port}`

    await fetch(`${base}/relay/providers/openai/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ enabled: 'true' }).toString()
    })

    await fetch(`${base}/relay/model-groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        groupId: 'g1',
        groupName: 'high-updated',
        groupModels: 'anthropic/claude-sonnet-4-5,openai/gpt-5.4',
        enabled: 'false'
      }).toString()
    })

    const settingsResponse = await fetch(`${base}/relay/settings-state`)
    const settings = await settingsResponse.json() as {
      providerEnabled: Record<string, boolean>
      modelGroups: Array<{ id: string, name: string, models: string[], enabled: boolean }>
    }

    expect(settings.providerEnabled.openai).toBe(true)
    expect(settings.modelGroups).toContainEqual({
      id: 'g1',
      name: 'high-updated',
      models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.4'],
      enabled: false
    })
  })
})
