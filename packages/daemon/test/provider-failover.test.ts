import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonController } from '../src/index.js'

const controllers: ReturnType<typeof createDaemonController>[] = []
const tempDirs: string[] = []

afterEach(async () => {
  while (controllers.length > 0) {
    const controller = controllers.pop()
    if (controller) {
      await controller.stop()
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe('provider scoped failover', () => {
  it('routes model group through provider path and fails over to next model on retryable status', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'viberelay-provider-failover-'))
    tempDirs.push(stateDir)

    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const controller = createDaemonController({
      port: 0,
      stateDir,
      upstreamFetch,
      modelGroups: [
        { id: 'g1', name: 'high', models: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4-5'], enabled: true }
      ]
    })
    controllers.push(controller)
    const started = await controller.start()

    const response = await fetch(`http://${started.host}:${started.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'high', input: 'hi' })
    })

    expect(response.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toContain('/api/provider/openai/v1/responses')
    expect(String(upstreamFetch.mock.calls[1]?.[0])).toContain('/api/provider/anthropic/v1/responses')
  })
})
