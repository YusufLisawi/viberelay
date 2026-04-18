import { describe, expect, it } from 'vitest'
import { extractProvider, providerScopedPath, rewriteModelInBody } from '../src/proxy/forwarding.js'

describe('provider routing helpers', () => {
  it('extracts provider prefix from qualified model names', () => {
    expect(extractProvider('openai/gpt-5.4')).toBe('openai')
    expect(extractProvider('claude-sonnet-4-5')).toBeUndefined()
  })

  it('rewrites generic api path to provider scoped path', () => {
    expect(providerScopedPath('/v1/responses', 'openai')).toBe('/api/provider/openai/v1/responses')
    expect(providerScopedPath('/api/v1/messages', 'anthropic')).toBe('/api/provider/anthropic/v1/messages')
  })

  it('rewrites model in request body while stripping provider prefix', () => {
    expect(rewriteModelInBody(JSON.stringify({ model: 'high' }), 'anthropic/claude-sonnet-4-5')).toBe(JSON.stringify({ model: 'claude-sonnet-4-5' }))
  })
})
