import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelGroup } from '../proxy/model-group-router.js'

export interface CustomModelEntry {
  owner: string
  id: string
}

export interface SettingsState {
  providerEnabled: Record<string, boolean>
  accountEnabled: Record<string, boolean>
  accountLabels: Record<string, string>
  removedAccounts: string[]
  modelGroups: ModelGroup[]
  customModels: CustomModelEntry[]
}

export class SettingsStore {
  readonly filePath: string
  state: SettingsState

  constructor(stateDir: string, initial: SettingsState) {
    this.filePath = join(stateDir, 'settings-state.json')
    this.state = {
      providerEnabled: initial.providerEnabled,
      accountEnabled: initial.accountEnabled,
      accountLabels: initial.accountLabels ?? {},
      removedAccounts: initial.removedAccounts,
      modelGroups: initial.modelGroups,
      customModels: initial.customModels ?? []
    }
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SettingsState>
      this.state = {
        providerEnabled: parsed.providerEnabled ?? this.state.providerEnabled,
        accountEnabled: parsed.accountEnabled ?? {},
        accountLabels: parsed.accountLabels ?? {},
        removedAccounts: parsed.removedAccounts ?? [],
        modelGroups: parsed.modelGroups ?? this.state.modelGroups,
        customModels: parsed.customModels ?? this.state.customModels ?? []
      }
    } catch {
      await this.save()
    }
    return this.state
  }

  async save() {
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8')
  }

  async setProviderEnabled(provider: string, enabled: boolean) {
    this.state.providerEnabled[provider] = enabled
    await this.save()
  }

  async setAccountEnabled(accountFile: string, enabled: boolean) {
    this.state.accountEnabled[accountFile] = enabled
    if (enabled) {
      this.state.removedAccounts = this.state.removedAccounts.filter((file) => file !== accountFile)
    }
    await this.save()
  }

  async removeAccount(accountFile: string) {
    if (!this.state.removedAccounts.includes(accountFile)) {
      this.state.removedAccounts.push(accountFile)
    }
    delete this.state.accountEnabled[accountFile]
    delete this.state.accountLabels[accountFile]
    await this.save()
  }

  async setAccountLabel(accountFile: string, label: string) {
    const trimmed = label.trim()
    if (trimmed.length === 0) {
      delete this.state.accountLabels[accountFile]
    } else {
      this.state.accountLabels[accountFile] = trimmed
      this.state.removedAccounts = this.state.removedAccounts.filter((file) => file !== accountFile)
    }
    await this.save()
  }

  async upsertModelGroup(group: ModelGroup) {
    const index = this.state.modelGroups.findIndex((existing) => existing.id === group.id)
    if (index === -1) {
      this.state.modelGroups.push(group)
    } else {
      this.state.modelGroups[index] = group
    }
    await this.save()
  }

  async deleteModelGroup(id: string) {
    this.state.modelGroups = this.state.modelGroups.filter((group) => group.id !== id)
    await this.save()
  }

  async addCustomModel(entry: CustomModelEntry) {
    const normalizedOwner = entry.owner.trim()
    const normalizedId = entry.id.trim()
    if (!normalizedOwner || !normalizedId) return
    const exists = this.state.customModels.some((existing) => existing.owner === normalizedOwner && existing.id === normalizedId)
    if (exists) return
    this.state.customModels.push({ owner: normalizedOwner, id: normalizedId })
    await this.save()
  }

  async deleteCustomModel(owner: string, id: string) {
    this.state.customModels = this.state.customModels.filter((entry) => !(entry.owner === owner && entry.id === id))
    await this.save()
  }
}
