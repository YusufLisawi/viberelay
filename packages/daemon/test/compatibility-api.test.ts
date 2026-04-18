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

describe('compatibility api', () => {
  it('normalizes anthropic and openai compatible request bodies', async () => {
    const controller = createDaemonController({ port: 0 })
    controllers.push(controller)
    const started = await controller.start()

    const thinkingResponse = await fetch(`http://${started.host}:${started.port}/relay/normalize-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5-thinking-8000', messages: [] })
    })
    const reasoningResponse = await fetch(`http://${started.host}:${started.port}/relay/normalize-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-reasoning-low', input: 'hi' })
    })

    const thinking = await thinkingResponse.json() as { model: string, thinking: { budget_tokens: number } }
    const reasoning = await reasoningResponse.json() as { model: string, reasoning: { effort: string } }

    expect(thinking.model).toBe('claude-sonnet-4-5')
    expect(thinking.thinking.budget_tokens).toBe(8000)
    expect(reasoning.model).toBe('gpt-5.4')
    expect(reasoning.reasoning.effort).toBe('low')
  })

  it('injects synthetic variants on /v1/models from upstream-like catalog', async () => {
    const controller = createDaemonController({
      port: 0,
      upstreamModels: [
        { id: 'claude-sonnet-4-5', owned_by: 'anthropic' },
        { id: 'gpt-5.4', owned_by: 'openai' }
      ],
      modelGroups: [{ id: 'g1', name: 'high', models: ['claude-sonnet-4-5'], enabled: true }]
    })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/models`)
    const payload = await response.json() as { data: Array<{ id: string, owned_by: string }> }
    const ids = payload.data.map((entry) => entry.id)

    expect(ids).toContain('claude-sonnet-4-5-thinking-8000')
    expect(ids).toContain('gpt-5.4-reasoning-low')
    expect(ids).toContain('gpt-5.4-mini')
    expect(ids).toContain('high')
  })
})
