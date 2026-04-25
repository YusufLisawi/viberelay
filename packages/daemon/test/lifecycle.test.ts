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

describe('daemon lifecycle', () => {
  it('starts daemon and serves health payload', async () => {
    const controller = createDaemonController({ port: 0 })
    controllers.push(controller)

    const started = await controller.start()
    const response = await fetch(`http://${started.host}:${started.port}/health`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'viberelay'
    })
  })

  it('makes second start idempotent', async () => {
    const controller = createDaemonController({ port: 0 })
    controllers.push(controller)

    const first = await controller.start()
    const second = await controller.start()

    expect(second.port).toBe(first.port)
    expect(second.pid).toBe(first.pid)
  })

  it('stops daemon cleanly', async () => {
    const controller = createDaemonController({ port: 0 })
    const started = await controller.start()

    await controller.stop()

    await expect(fetch(`http://${started.host}:${started.port}/health`)).rejects.toThrow()
  })

  it('starts CLIProxyAPI child process', async () => {
    const controller = createDaemonController({ port: 0 })
    controllers.push(controller)

    const started = await controller.start()

    expect(started.childPid).toBeTypeOf('number')
    expect(started.childPid).toBeGreaterThan(0)
  })
})
