import { describe, expect, it } from 'vitest'
import { ensureCurrentDay, recordAccountHit, recordUsage, type UsageStats } from '../src/proxy/forwarding.js'

function emptyStats(): UsageStats {
  return {
    totalRequests: 0,
    endpointCounts: {},
    providerCounts: {},
    modelCounts: {},
    accountCounts: {},
    accountRotationIndex: {}
  }
}

describe('usage daily reset', () => {
  it('resets counters when the local date changes, preserves rotation + last-hit', () => {
    const stats = emptyStats()

    const day1 = new Date('2026-04-19T12:00:00Z')
    ensureCurrentDay(stats, () => day1)
    recordUsage(stats, 'POST', '/v1/messages', 'model-a', () => day1)
    recordAccountHit(stats, 'codex', 'acct-1.json', () => day1)
    stats.accountRotationIndex['codex'] = 3
    stats.lastModel = 'model-a'

    expect(stats.totalRequests).toBe(1)
    expect(stats.providerCounts.codex).toBe(1)
    expect(stats.accountCounts.codex?.['acct-1.json']).toBe(1)

    const day2 = new Date('2026-04-20T00:05:00Z')
    const rolled = ensureCurrentDay(stats, () => day2)
    expect(rolled).toBe(true)
    expect(stats.totalRequests).toBe(0)
    expect(stats.providerCounts).toEqual({})
    expect(stats.accountCounts).toEqual({})
    expect(stats.modelCounts).toEqual({})
    expect(stats.accountRotationIndex.codex).toBe(3)
    expect(stats.lastModel).toBe('model-a')
    expect(stats.statsDay).toBe('2026-04-20')
  })

  it('does not reset on same day', () => {
    const stats = emptyStats()
    const clock = new Date('2026-04-19T10:00:00Z')
    ensureCurrentDay(stats, () => clock)
    recordUsage(stats, 'POST', '/v1/messages', undefined, () => clock)
    const rolled = ensureCurrentDay(stats, () => clock)
    expect(rolled).toBe(false)
    expect(stats.totalRequests).toBe(1)
  })

  it('recordUsage auto-rolls when a new day starts mid-traffic', () => {
    const stats = emptyStats()
    const day1 = new Date(2026, 3, 19, 23, 59, 30)
    ensureCurrentDay(stats, () => day1)
    recordUsage(stats, 'POST', '/v1/messages', undefined, () => day1)
    recordUsage(stats, 'POST', '/v1/messages', undefined, () => day1)
    expect(stats.totalRequests).toBe(2)

    const day2 = new Date(2026, 3, 20, 0, 0, 30)
    recordUsage(stats, 'POST', '/v1/messages', undefined, () => day2)
    expect(stats.totalRequests).toBe(1)
  })
})
