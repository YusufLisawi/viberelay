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

describe('dashboard shell', () => {
  it('renders server-side status, usage, and model-group sections', async () => {
    const controller = createDaemonController({
      port: 0,
      modelGroups: [{ id: 'g1', name: 'high', models: ['claude'], enabled: true }]
    })
    controllers.push(controller)

    const started = await controller.start()
    const response = await fetch(`http://${started.host}:${started.port}/dashboard`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('VibeRelay Dashboard')
    expect(html).toContain('Server running')
    expect(html).toContain('Model Groups')
    expect(html).toContain('high')
    expect(html).toContain('Usage')
  })
})
