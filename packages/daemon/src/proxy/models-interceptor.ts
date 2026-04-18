export interface ModelEntry {
  id: string
  owned_by: string
}

export interface ModelsResponse {
  data: ModelEntry[]
}

const reasoningEfforts = ['low', 'medium', 'high']
const effortLevels = ['low', 'medium', 'high', 'max']
const thinkingBudgets = [8000, 16000, 32000]
const syntheticOpenAIModels = ['gpt-5.4-mini', 'gpt-5.4-nano']

export function shouldInterceptModelsRequest(method: string, path: string) {
  return method === 'GET' && (path === '/v1/models' || path === '/api/v1/models')
}

export function injectGroupModels(response: ModelsResponse, groupNames: string[]) {
  const data = [...response.data]
  const existing = data.map((entry) => ({ id: entry.id, owner: entry.owned_by ?? 'viberelay' }))
  const existingOpenAI = new Set(existing.filter((entry) => entry.owner === 'openai').map((entry) => entry.id))

  if (existing.some((entry) => entry.owner === 'openai')) {
    for (const modelId of syntheticOpenAIModels) {
      if (!existingOpenAI.has(modelId)) {
        data.push({ id: modelId, owned_by: 'openai' })
      }
    }
  }

  for (const entry of existing) {
    if (entry.owner === 'anthropic' && entry.id.startsWith('claude-')) {
      for (const budget of thinkingBudgets) {
        data.push({ id: `${entry.id}-thinking-${budget}`, owned_by: entry.owner })
      }
      for (const level of effortLevels) {
        data.push({ id: `${entry.id}-effort-${level}`, owned_by: entry.owner })
      }
    } else if (entry.owner === 'openai' && entry.id.startsWith('gpt-')) {
      for (const effort of reasoningEfforts) {
        data.push({ id: `${entry.id}-reasoning-${effort}`, owned_by: entry.owner })
      }
    }
  }

  const existingIds = new Set(data.map((entry) => entry.id))
  for (const groupName of groupNames) {
    if (existingIds.has(groupName)) {
      continue
    }
    data.push({ id: groupName, owned_by: 'viberelay' })
    existingIds.add(groupName)
  }

  return { data }
}
