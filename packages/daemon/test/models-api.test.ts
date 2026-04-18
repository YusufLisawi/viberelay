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

describe('models api', () => {
  it('returns synthetic model-group entries owned by viberelay', async () => {
    const controller = createDaemonController({
      port: 0,
      modelGroups: [
        { id: 'g1', name: 'high', models: ['claude-sonnet-4-5', 'gpt-5.4'], enabled: true },
        { id: 'g2', name: 'off', models: ['gemini-2.5-pro'], enabled: false }
      ]
    })
    controllers.push(controller)

    const started = await controller.start()
    const response = await fetch(`http://${started.host}:${started.port}/v1/models`)
    const payload = await response.json() as { data: Array<{ id: string, owned_by: string }> }

    expect(response.status).toBe(200)
    expect(payload.data).toEqual([
      { id: 'high', owned_by: 'viberelay' }
    ])
  })
})
