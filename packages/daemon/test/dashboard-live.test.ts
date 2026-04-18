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

describe('dashboard live interactions', () => {
  it('renders polling script and action buttons', async () => {
    const controller = createDaemonController({ port: 0 })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/dashboard`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('pollDashboard')
    expect(html).toContain('data-action="start"')
    expect(html).toContain('data-action="stop"')
    expect(html).toContain('Refresh now')
  })
})
