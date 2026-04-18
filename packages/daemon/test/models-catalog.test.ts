import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonController } from '../src/index.js'

const controllers: ReturnType<typeof createDaemonController>[] = []

afterEach(async () => {
  while (controllers.length > 0) {
    const controller = controllers.pop()
    if (controller) {
      await controller.stop()
    }
  }
})

describe('models catalog parity', () => {
  it('returns grouped model catalog including provider models and group aliases', async () => {
    const controller = createDaemonController({
      port: 0,
      upstreamModels: [
        { id: 'claude-sonnet-4-5', owned_by: 'anthropic' },
        { id: 'gpt-5.4', owned_by: 'openai' }
      ],
      modelGroups: [{ id: 'g1', name: 'high', models: ['anthropic/claude-sonnet-4-5'], enabled: true }]
    })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/relay/models-catalog`)
    const payload = await response.json() as { groups: Record<string, Array<{ id: string }>> }

    expect(response.status).toBe(200)
    expect(payload.groups.anthropic.some((model) => model.id === 'claude-sonnet-4-5')).toBe(true)
    expect(payload.groups.openai.some((model) => model.id === 'gpt-5.4')).toBe(true)
    expect(payload.groups.viberelay.some((model) => model.id === 'high')).toBe(true)
  })
})
