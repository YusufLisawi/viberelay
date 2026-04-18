import { describe, expect, it, vi } from 'vitest'
import { runDashboardCommand } from '../src/commands/dashboard.js'

describe('dashboard open command', () => {
  it('opens dashboard URL with platform opener and returns url', async () => {
    const openUrl = vi.fn(async () => undefined)

    const result = await runDashboardCommand({
      baseUrl: 'http://127.0.0.1:8317',
      openUrl
    })

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:8317/dashboard')
    expect(result).toContain('/dashboard')
  })
})
