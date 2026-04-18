import { describe, expect, it } from 'vitest'
import { composeAdditiveBaseConfig, composeRuntimeConfig, parseCustomProviders, validateCustomProviders } from '../src/backend/config-composer.js'

describe('config composer', () => {
  it('deep merges user config over bundled base while preserving unrelated keys', () => {
    const baseRoot = {
      debug: false,
      nested: { one: true, two: false },
      'openai-compatibility': [
        { name: 'custom-one', 'base-url': 'https://base.example.com' }
      ]
    }

    const merged = composeAdditiveBaseConfig(baseRoot, {
      debug: true,
      nested: { two: true },
      'openai-compatibility': [
        { name: 'custom-one', 'display-name': 'Custom One' },
        { name: 'custom-two', 'base-url': 'https://two.example.com' }
      ]
    })

    expect(merged).toEqual({
      debug: true,
      nested: { one: true, two: true },
      'openai-compatibility': [
        { name: 'custom-one', 'base-url': 'https://base.example.com', 'display-name': 'Custom One' },
        { name: 'custom-two', 'base-url': 'https://two.example.com' }
      ]
    })
  })

  it('validates reserved and malformed custom providers like root logic', () => {
    const errors = validateCustomProviders({
      'openai-compatibility': [
        { name: ' claude ', 'base-url': 'https://bad.example.com' },
        { name: 'codex', 'base-url': '' },
        { name: 'custom-ok', 'base-url': 'https://good.example.com', 'api-key-entries': [{ 'api-key': '' }] }
      ]
    }, new Set(['claude', 'codex']))

    expect(errors).toContain("Provider name ' claude ' must not include leading or trailing whitespace.")
    expect(errors).toContain("Provider 'codex' is reserved and cannot be declared under openai-compatibility.")
    expect(errors).toContain('openai-compatibility[2].api-key-entries[0] must define a non-empty api-key.')
  })

  it('parses custom providers with aliases and deduplicated inline keys', () => {
    const providers = parseCustomProviders({
      'openai-compatibility': [
        {
          name: 'custom-one',
          'display-name': 'Custom One',
          'base-url': 'https://custom.example.com',
          models: [{ alias: 'high' }, { name: 'mid' }],
          'api-key-entries': [{ 'api-key': 'key-1' }, { 'api-key': 'key-1' }, { 'api-key': 'key-2' }]
        }
      ]
    }, new Set(['claude']))

    expect(providers).toEqual([
      {
        id: 'custom-one',
        title: 'Custom One',
        baseURL: 'https://custom.example.com',
        helpText: undefined,
        iconSystemName: undefined,
        modelAliases: ['high', 'mid'],
        inlineAPIKeys: ['key-1', 'key-2']
      }
    ])
  })

  it('builds runtime config with oauth wildcard exclusions and auth-backed api keys', () => {
    const runtime = composeRuntimeConfig({
      'oauth-excluded-models': {
        claude: ['existing-model']
      },
      'openai-compatibility': [
        {
          name: 'custom-one',
          'base-url': 'https://custom.example.com',
          'api-key-entries': [{ 'api-key': 'inline-key' }],
          'display-name': 'Hide Me'
        }
      ]
    }, {
      reservedCustomProviderKeys: new Set(['claude', 'codex']),
      disabledCustomProviderIDs: new Set(),
      disabledOAuthProviderKeys: ['claude', 'codex'],
      zaiAPIKeys: [],
      customProviderAuthRecords: [
        { providerID: 'custom-one', apiKey: 'auth-key', isDisabled: false }
      ],
      includeManagedZAIProvider: false
    })

    expect(runtime['oauth-excluded-models']).toEqual({
      claude: ['existing-model', '*'],
      codex: ['*']
    })
    expect(runtime['openai-compatibility']).toEqual([
      {
        name: 'custom-one',
        'base-url': 'https://custom.example.com',
        'api-key-entries': [{ 'api-key': 'inline-key' }, { 'api-key': 'auth-key' }]
      }
    ])
  })
})
