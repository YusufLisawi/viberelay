import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('usage tracking and model-group hits', () => {
  it('tracks inbound endpoint hits and last resolved model for model-group request', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'viberelay-usage-tracking-'))
    tempDirs.push(stateDir)

    const controller = createDaemonController({
      port: 0,
      stateDir,
      modelGroups: [{ id: 'g1', name: 'high', models: ['claude', 'codex'], enabled: true }]
    })
    controllers.push(controller)

    const started = await controller.start()

    await fetch(`http://${started.host}:${started.port}/v1/models`)
    await fetch(`http://${started.host}:${started.port}/relay/resolve-model?name=high`)

    const usageResponse = await fetch(`http://${started.host}:${started.port}/usage`)
    const statusResponse = await fetch(`http://${started.host}:${started.port}/status`)
    const usage = await usageResponse.json() as {
      total_requests: number
      endpoint_counts: Record<string, number>
      model_counts: Record<string, number>
    }
    const status = await statusResponse.json() as {
      model_groups: { last_hit_by_group_id: Record<string, string> }
    }

    expect(usage.total_requests).toBe(2)
    expect(usage.endpoint_counts['GET /v1/models']).toBe(1)
    expect(usage.endpoint_counts['GET /relay/resolve-model']).toBe(1)
    expect(usage.model_counts.claude).toBe(1)
    expect(status.model_groups.last_hit_by_group_id).toEqual({ g1: 'claude' })
  })
})
