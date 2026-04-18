export interface ModelGroup {
  id: string
  name: string
  models: string[]
  enabled: boolean
}

export class ModelGroupRouter {
  #groups: ModelGroup[] = []
  #counters: Record<string, number> = {}
  #lastResolvedModels: Record<string, string> = {}

  updateGroups(groups: ModelGroup[]) {
    this.#groups = groups.filter((group) => group.enabled && group.models.length > 0)
    const validIds = new Set(this.#groups.map((group) => group.id))
    this.#counters = Object.fromEntries(Object.entries(this.#counters).filter(([groupId]) => validIds.has(groupId)))
    this.#lastResolvedModels = Object.fromEntries(Object.entries(this.#lastResolvedModels).filter(([groupId]) => validIds.has(groupId)))
  }

  resolveModel(model: string) {
    const group = this.#groups.find((candidate) => candidate.name === model)
    if (!group) {
      return undefined
    }

    const index = (this.#counters[group.id] ?? 0) % group.models.length
    this.#counters[group.id] = (index + 1) % group.models.length
    const realModel = group.models[index]!
    this.#lastResolvedModels[group.id] = realModel
    return { groupId: group.id, realModel }
  }

  failoverModel(groupId: string, tried: Set<string>) {
    const group = this.#groups.find((candidate) => candidate.id === groupId)
    if (!group) {
      return undefined
    }

    const nextModel = group.models.find((model) => !tried.has(model))
    if (!nextModel) {
      return undefined
    }

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
