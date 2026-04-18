import { describe, expect, it } from 'vitest'
import { injectGroupModels, shouldInterceptModelsRequest } from '../src/proxy/models-interceptor.js'

describe('models interceptor', () => {
  it('intercepts GET /v1/models', () => {
    expect(shouldInterceptModelsRequest('GET', '/v1/models')).toBe(true)
    expect(shouldInterceptModelsRequest('GET', '/api/v1/models')).toBe(true)
    expect(shouldInterceptModelsRequest('POST', '/v1/models')).toBe(false)
  })

  it('injects synthetic variants and model groups into models response', () => {
    const upstream = {
      data: [
        { id: 'claude-sonnet-4-5', owned_by: 'anthropic' },
        { id: 'gpt-5.4', owned_by: 'openai' }
      ]
    }

    const injected = injectGroupModels(upstream, ['high'])
    const ids = injected.data.map((entry) => entry.id)

    expect(ids).toContain('claude-sonnet-4-5-thinking-8000')
    expect(ids).toContain('claude-sonnet-4-5-effort-high')
    expect(ids).toContain('gpt-5.4-reasoning-low')
    expect(ids).toContain('gpt-5.4-mini')
    expect(ids).toContain('high')
    expect(injected.data.find((entry) => entry.id === 'high')?.owned_by).toBe('viberelay')
  })
})
