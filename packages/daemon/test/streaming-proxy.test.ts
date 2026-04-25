import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('streaming proxy', () => {
  it('streams upstream response body without JSON buffering requirement', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk-1'))
        controller.enqueue(new TextEncoder().encode('chunk-2'))
        controller.close()
      }
    })

    const upstreamFetch = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }))

    const controller = createDaemonController({ port: 0, upstreamFetch, providerUsageByAccount: {}, upstreamModels: [] })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-reasoning-low', input: 'hi', stream: true })
    })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(text).toBe('chunk-1chunk-2')
  })
})
