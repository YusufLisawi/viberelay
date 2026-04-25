import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonController } from '../src/index.js'

const controllers: ReturnType<typeof createDaemonController>[] = []

type UpstreamFetch = typeof fetch

const makeUpstreamFetch = (impl: UpstreamFetch) => impl

afterEach(async () => {
  while (controllers.length > 0) {
    const controller = controllers.pop()
    if (controller) {
      await controller.stop()
    }
  }
})

describe('proxy forwarding', () => {
  it('normalizes request before forwarding to upstream', async () => {
    const upstreamFetch = vi.fn(makeUpstreamFetch(async (_input, init) => {
      return new Response(JSON.stringify({
        ok: true,
        echoed: JSON.parse(String(init?.body))
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const controller = createDaemonController({ port: 0, upstreamFetch, providerUsageByAccount: {}, upstreamModels: [] })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-thinking-8000',
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    const payload = await response.json() as { echoed: { model: string, thinking: { budget_tokens: number } } }

    expect(response.status).toBe(200)
    expect(payload.echoed.model).toBe('claude-sonnet-4-5')
    expect(payload.echoed.thinking.budget_tokens).toBe(8000)
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
  })

  it('retries once after invalid thinking signature by stripping thinking blocks', async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid thinking signature' }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockImplementationOnce(makeUpstreamFetch(async (_input, init) => new Response(JSON.stringify({
        ok: true,
        echoed: JSON.parse(String(init?.body))
      }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const controller = createDaemonController({ port: 0, upstreamFetch, providerUsageByAccount: {}, upstreamModels: [] })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret', signature: 'sig' },
            { type: 'text', text: 'answer' }
          ]
        }]
      })
    })
    const payload = await response.json() as { echoed: { messages: Array<{ content: Array<{ type: string }> }> } }

    expect(response.status).toBe(200)
    expect(payload.echoed.messages[0].content).toEqual([{ type: 'text', text: 'answer' }])
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('retries once after model_not_supported error with same normalized body', async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'model_not_supported' }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const controller = createDaemonController({ port: 0, upstreamFetch, providerUsageByAccount: {}, upstreamModels: [] })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-reasoning-low', input: 'hi' })
    })

    expect(response.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(String(upstreamFetch.mock.calls[0]?.[1]?.body)) as { model: string, reasoning: { effort: string } }
    expect(firstBody.model).toBe('gpt-5.4')
    expect(firstBody.reasoning.effort).toBe('low')
  })
})
