import { describe, expect, it } from 'vitest'
import { ModelGroupRouter } from '../src/proxy/model-group-router.js'

describe('model group router', () => {
  it('round robins by group name and tracks last resolved model', () => {
    const router = new ModelGroupRouter()
    router.updateGroups([
      { id: 'g1', name: 'high', models: ['claude', 'codex'], enabled: true }
    ])

    expect(router.resolveModel('high')).toEqual({ groupId: 'g1', groupName: 'high', realModel: 'claude' })
    expect(router.resolveModel('high')).toEqual({ groupId: 'g1', groupName: 'high', realModel: 'codex' })
    expect(router.lastResolvedModelsByGroupId()).toEqual({ g1: 'codex' })
  })

  it('fails over to first untried model', () => {
    const router = new ModelGroupRouter()
    router.updateGroups([
      { id: 'g1', name: 'high', models: ['claude', 'codex', 'gemini'], enabled: true }
    ])

    expect(router.failoverModel('g1', new Set(['claude', 'codex']))).toBe('gemini')
    expect(router.lastResolvedModelsByGroupId()).toEqual({ g1: 'gemini' })
  })

  it('drops disabled and empty groups from active names', () => {
    const router = new ModelGroupRouter()
    router.updateGroups([
      { id: 'g1', name: 'high', models: ['claude'], enabled: true },
      { id: 'g2', name: 'off', models: ['codex'], enabled: false },
      { id: 'g3', name: 'empty', models: [], enabled: true }
    ])

    expect(router.activeGroupNames()).toEqual(['high'])
  })

  it('primary strategy always picks the first model on the happy path', () => {
    const router = new ModelGroupRouter()
    router.updateGroups([
      { id: 'g1', name: 'high', models: ['claude', 'codex'], enabled: true, strategy: 'primary' }
    ])

    expect(router.resolveModel('high')?.realModel).toBe('claude')
    expect(router.resolveModel('high')?.realModel).toBe('claude')
    expect(router.resolveModel('high')?.realModel).toBe('claude')
  })

  it('weighted strategy distributes per weights', () => {
    let i = 0
    const samples = [0.1, 0.5, 0.9]
    const router = new ModelGroupRouter(() => samples[(i++) % samples.length]!)
    router.updateGroups([
      { id: 'g1', name: 'mid', models: ['claude', 'codex'], enabled: true, strategy: 'weighted', weights: [70, 30] }
    ])

    expect(router.resolveModel('mid')?.realModel).toBe('claude')
    expect(router.resolveModel('mid')?.realModel).toBe('claude')
    expect(router.resolveModel('mid')?.realModel).toBe('codex')
  })

  it('weighted strategy falls back to round-robin when weights are missing', () => {
    const router = new ModelGroupRouter(() => 0.999)
    router.updateGroups([
      { id: 'g1', name: 'mid', models: ['claude', 'codex'], enabled: true, strategy: 'weighted' }
    ])

    expect(router.resolveModel('mid')?.realModel).toBe('claude')
    expect(router.resolveModel('mid')?.realModel).toBe('codex')
  })
})
