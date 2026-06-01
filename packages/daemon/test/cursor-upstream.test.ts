import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonController } from '../src/index.js'
import type { CursorRunner } from '../src/proxy/cursor-upstream.js'

const controllers: ReturnType<typeof createDaemonController>[] = []

afterEach(async () => {
  while (controllers.length > 0) {
    const controller = controllers.pop()
    if (controller) await controller.stop()
  }
})

describe('Cursor upstream provider', () => {
  it('exposes Cursor models in /v1/models', async () => {
    const controller = createDaemonController({ port: 0, providerUsageByAccount: {}, upstreamModels: [] })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/models`)
    const payload = await response.json() as { data: Array<{ id: string, owned_by: string }> }

    expect(response.status).toBe(200)
    expect(payload.data.some((model) => model.owned_by === 'cursor' && model.id === 'cursor/claude-opus-4-7-high')).toBe(true)
  })

  it('routes OpenAI chat completions to cursor-agent for cursor-prefixed models', async () => {
    const cursorRunner = vi.fn<CursorRunner>(async () => ({ code: 0, stdout: 'cursor answer\n', stderr: '' }))
    const upstreamFetch = vi.fn<typeof fetch>()
    const controller = createDaemonController({ port: 0, providerUsageByAccount: {}, upstreamModels: [], upstreamFetch, cursorRunner })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cursor/claude-opus-4-7-high', messages: [{ role: 'user', content: 'hello' }] })
    })
    const payload = await response.json() as { model: string, choices: Array<{ message: { content: string } }> }

    expect(response.status).toBe(200)
    expect(payload.model).toBe('claude-opus-4-7-high')
    expect(payload.choices[0]!.message.content).toBe('cursor answer')
    expect(cursorRunner).toHaveBeenCalledWith(['--print', '--trust', '--mode', 'ask', '--model', 'claude-opus-4-7-high', 'user: hello'], expect.any(Object))
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('routes Anthropic messages to cursor-agent for cursor-prefixed models', async () => {
    const cursorRunner = vi.fn<CursorRunner>(async () => ({ code: 0, stdout: 'anthropic cursor answer\n', stderr: '' }))
    const controller = createDaemonController({ port: 0, providerUsageByAccount: {}, upstreamModels: [], cursorRunner })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cursor/composer-2.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
    })
    const payload = await response.json() as { model: string, content: Array<{ type: string, text: string }> }

    expect(response.status).toBe(200)
    expect(payload.model).toBe('composer-2.5')
    expect(payload.content).toEqual([{ type: 'text', text: 'anthropic cursor answer' }])
  })

  it('returns upstream error when cursor-agent fails', async () => {
    const cursorRunner = vi.fn<CursorRunner>(async () => ({ code: 1, stdout: '', stderr: 'not logged in' }))
    const controller = createDaemonController({ port: 0, providerUsageByAccount: {}, upstreamModels: [], cursorRunner })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cursor/claude-opus-4-7-high', messages: [{ role: 'user', content: 'hello' }] })
    })
    const payload = await response.json() as { error: { message: string, type: string } }

    expect(response.status).toBe(502)
    expect(payload.error.message).toBe('not logged in')
    expect(payload.error.type).toBe('cursor_upstream_error')
  })
})
