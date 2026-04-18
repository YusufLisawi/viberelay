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

describe('usage parity payload', () => {
  it('returns per-account provider usage with 5h weekly reset and percent fields', async () => {
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
      }
    })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/usage`)
    const payload = await response.json() as {
      provider_usage: Record<string, Record<string, {
        primaryUsedPercent: number
        primaryResetSeconds: number
        secondaryUsedPercent: number
        secondaryResetSeconds: number
      }>>
    }

    expect(response.status).toBe(200)
    expect(payload.provider_usage.claude['claude-account'].primaryUsedPercent).toBe(42)
    expect(payload.provider_usage.claude['claude-account'].primaryResetSeconds).toBe(7200)
    expect(payload.provider_usage.claude['claude-account'].secondaryUsedPercent).toBe(61)
    expect(payload.provider_usage.claude['claude-account'].secondaryResetSeconds).toBe(172800)
  })
})
