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

describe('dashboard usage and models visibility', () => {
  it('renders 5h weekly usage windows and models catalog sections', async () => {
    const controller = createDaemonController({
      port: 0,
      providerUsageByAccount: {
        claude: {
          'claude-account': {
            status: 'loaded',
            primaryUsedPercent: 42,
            primaryResetSeconds: 7200,
            secondaryUsedPercent: 61,
            secondaryResetSeconds: 172800,
            creditBalance: 12.5,
            planType: 'max'
          }
        }
      },
      upstreamModels: [
        { id: 'claude-sonnet-4-5', owned_by: 'anthropic' },
        { id: 'gpt-5.4', owned_by: 'openai' }
      ],
      modelGroups: [{ id: 'g1', name: 'high', models: ['anthropic/claude-sonnet-4-5'], enabled: true }]
    })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/dashboard`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('5h')
    expect(html).toContain('Weekly')
    expect(html).toContain('42% used')
    expect(html).toContain('61% used')
    expect(html).toContain('Models Catalog')
    expect(html).toContain('claude-sonnet-4-5')
    expect(html).toContain('gpt-5.4')
    expect(html).toContain('high')
  })
})
