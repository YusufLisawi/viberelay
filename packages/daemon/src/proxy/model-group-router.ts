export type ModelGroupStrategy = 'round-robin' | 'weighted' | 'primary'

export interface ModelGroup {
  id: string
  name: string
  models: string[]
  enabled: boolean
  strategy?: ModelGroupStrategy
  weights?: number[]
}

export class ModelGroupRouter {
  #groups: ModelGroup[] = []
  #counters: Record<string, number> = {}
  #lastResolvedModels: Record<string, string> = {}
  #rng: () => number

  constructor(rng: () => number = Math.random) {
    this.#rng = rng
  }

  updateGroups(groups: ModelGroup[]) {
    this.#groups = groups.filter((group) => group.enabled && group.models.length > 0)
    const validIds = new Set(this.#groups.map((group) => group.id))
    this.#counters = Object.fromEntries(Object.entries(this.#counters).filter(([groupId]) => validIds.has(groupId)))
    this.#lastResolvedModels = Object.fromEntries(Object.entries(this.#lastResolvedModels).filter(([groupId]) => validIds.has(groupId)))
  }

  resolveModel(model: string) {
    const group = this.#groups.find((candidate) => candidate.name === model)
    if (!group) return undefined

    const realModel = pickModel(group, this.#counters, this.#rng)
    this.#lastResolvedModels[group.id] = realModel
    return { groupId: group.id, groupName: group.name, realModel }
  }

  failoverModel(groupId: string, tried: Set<string>) {
    const group = this.#groups.find((candidate) => candidate.id === groupId)
    if (!group) return undefined

    const nextModel = group.models.find((model) => !tried.has(model))
    if (!nextModel) return undefined

    this.#lastResolvedModels[group.id] = nextModel
    return nextModel
  }

  activeGroupNames() {
    return this.#groups.map((group) => group.name)
  }

  lastResolvedModelsByGroupId() {
    return { ...this.#lastResolvedModels }
  }
}

function pickModel(group: ModelGroup, counters: Record<string, number>, rng: () => number): string {
  const strategy = group.strategy ?? 'round-robin'

  if (strategy === 'primary') {
    return group.models[0]!
  }

  if (strategy === 'weighted') {
    const weights = normalizeWeights(group.weights, group.models.length)
    if (weights) {
      const roll = rng()
      let cumulative = 0
      for (let i = 0; i < group.models.length; i++) {
        cumulative += weights[i]!
        if (roll < cumulative) return group.models[i]!
      }
      return group.models[group.models.length - 1]!
    }
  }

  const index = (counters[group.id] ?? 0) % group.models.length
  counters[group.id] = (index + 1) % group.models.length
  return group.models[index]!
}

function normalizeWeights(weights: number[] | undefined, expectedLength: number): number[] | null {
  if (!weights || weights.length !== expectedLength) return null
  const sanitized = weights.map((value) => Number.isFinite(value) && value > 0 ? value : 0)
  const total = sanitized.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  return sanitized.map((value) => value / total)
}
