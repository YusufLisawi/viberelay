import { describe, expect, it } from 'vitest'
import { ModelGroupRouter } from '../src/proxy/model-group-router.js'

describe('model group router', () => {
  it('round robins by group name and tracks last resolved model', () => {
    const router = new ModelGroupRouter()
    router.updateGroups([
      { id: 'g1', name: 'high', models: ['claude', 'codex'], enabled: true }
    ])

    expect(router.resolveModel('high')).toEqual({ groupId: 'g1', realModel: 'claude' })
    expect(router.resolveModel('high')).toEqual({ groupId: 'g1', realModel: 'codex' })
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
})
