import type { ModelGroup } from '../proxy/model-group-router.js'

export const DEFAULT_MODEL_GROUPS: ModelGroup[] = [
  {
    id: '4EEBCEE0-55B6-4A4F-B875-C95A3DDFD54E',
    name: 'high',
    models: ['openai/gpt-5.4-reasoning-high'],
    enabled: true
  },
  {
    id: '1CB78ECB-A1D4-4C37-B9CD-26A77DD428F6',
    name: 'mid',
    models: ['openai/gpt-5.4-reasoning-low'],
    enabled: true
  },
  {
    id: '3633277B-8B99-4DC1-8FB4-656E1B752AB1',
    name: 'low',
    models: ['openai/gpt-5.4-mini-reasoning-low'],
    enabled: true
  }
]

export const DEFAULT_PROVIDER_ENABLED: Record<string, boolean> = {
  claude: true,
  'github-copilot': true,
  codex: true,
  cursor: false,
  kilo: false,
  kimi: false,
  kiro: false,
  qwen: false,
  zai: false
}

export const REMOVED_PROVIDERS = new Set(['antigravity', 'gemini', 'google'])
export const LOCKED_MODEL_GROUP_NAMES = new Set(['high', 'mid', 'low'])
