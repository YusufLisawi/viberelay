import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonController } from '../../daemon/src/index.js'
import { runDashboardCommand } from '../src/commands/dashboard.js'
import { runStartCommand } from '../src/commands/start.js'
import { runStopCommand } from '../src/commands/stop.js'

const controllers: ReturnType<typeof createDaemonController>[] = []

afterEach(async () => {
  while (controllers.length > 0) {
    const controller = controllers.pop()
    if (controller) {
      await controller.stop()
    }
  }
})

describe('lifecycle commands', () => {
  it('prints normalized start stop and dashboard outputs', async () => {
    const controller = createDaemonController({ port: 0 })
    controllers.push(controller)
    const started = await controller.start()
    const baseUrl = `http://${started.host}:${started.port}`

    const startOutput = await runStartCommand({ baseUrl })
    const dashboardOutput = await runDashboardCommand({ baseUrl })
    const stopOutput = await runStopCommand({ baseUrl })

    expect(startOutput).toContain('running')
    expect(dashboardOutput).toContain('/dashboard')
    expect(stopOutput).toContain('stopped')
  })
})
