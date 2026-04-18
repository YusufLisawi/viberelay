export interface ConfigProviderAuthRecord {
  providerID: string
  apiKey: string
  isDisabled: boolean
}

export interface CustomProviderDefinition {
  id: string
  title: string
  baseURL: string
  helpText?: string
  iconSystemName?: string
  modelAliases: string[]
  inlineAPIKeys: string[]
}

export interface ComposeRuntimeConfigOptions {
  reservedCustomProviderKeys: Set<string>
  disabledCustomProviderIDs: Set<string>
  disabledOAuthProviderKeys: string[]
  zaiAPIKeys: string[]
  customProviderAuthRecords: ConfigProviderAuthRecord[]
  includeManagedZAIProvider: boolean
}

type Dict = Record<string, unknown>

function stringKeyedDictionary(value: unknown): Dict | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Dict
}

function stringKeyedDictionaryArray(value: unknown): Dict[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    const dictionary = stringKeyedDictionary(entry)
    return dictionary ? [dictionary] : []
  })
}

function normalizedString(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function normalizedProviderID(entry: Dict) {
  return normalizedString(entry.name)
}

function mergeDictionary(base: Dict, overlay: Dict): Dict {
  const merged: Dict = { ...base }

  for (const [key, overlayValue] of Object.entries(overlay)) {
    if (key === 'openai-compatibility' && Array.isArray(overlayValue)) {
      const overlayEntries = stringKeyedDictionaryArray(overlayValue)
      if (overlayEntries.length === 0) {
        merged[key] = overlayValue
      } else {
        const baseEntries = stringKeyedDictionaryArray(merged[key])
        merged[key] = mergeNamedEntries(baseEntries, overlayEntries)
      }
      continue
    }

    const overlayDictionary = stringKeyedDictionary(overlayValue)
    const baseDictionary = stringKeyedDictionary(merged[key])
    if (overlayDictionary && baseDictionary) {
      merged[key] = mergeDictionary(baseDictionary, overlayDictionary)
      continue
    }

    merged[key] = overlayValue
  }

  return merged
}

function mergeNamedEntries(base: Dict[], overlay: Dict[]) {
  const merged = [...base]
  const indexByName = new Map<string, number>()

  base.forEach((entry, index) => {
    const name = normalizedProviderID(entry)
    if (name) {
      indexByName.set(name, index)
      merged[index] = { ...entry, name }
    }
  })

  overlay.forEach((entry) => {
    const name = normalizedProviderID(entry)
    if (!name) {
      merged.push(entry)
      return
    }

    const canonicalOverlay = { ...entry, name }
    const existingIndex = indexByName.get(name)
    if (existingIndex === undefined) {
      indexByName.set(name, merged.length)
      merged.push(canonicalOverlay)
      return
    }

    merged[existingIndex] = mergeDictionary(merged[existingIndex] as Dict, canonicalOverlay)
  })

  return merged
}

function validateMappingArray(value: unknown, path: string) {
  if (!Array.isArray(value)) {
    return [`${path} must be an array of mappings.`]
  }

  return value.flatMap((entry, index) => stringKeyedDictionary(entry) ? [] : [`${path}[${index}] must be a mapping.`])
}

function apiKeyEntries(entry: Dict) {
  return stringKeyedDictionaryArray(entry['api-key-entries']).flatMap((keyEntry) => {
    const apiKey = normalizedString(keyEntry['api-key'])
    return apiKey ? [{ 'api-key': apiKey }] : []
  })
}

function deduplicatedAPIKeyEntries(entries: Array<{ 'api-key': string }>) {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry['api-key'])) {
      return false
    }

    seen.add(entry['api-key'])
    return true
  })
}

function deduplicatedAPIKeys(entry: Dict) {
  return deduplicatedAPIKeyEntries(apiKeyEntries(entry)).map((keyEntry) => keyEntry['api-key'])
}

function stripCustomProviderUIMetadata(entry: Dict) {
  const sanitized = { ...entry }
  delete sanitized['display-name']
  delete sanitized['help-text']
  delete sanitized['icon-system']
  return sanitized
}

function defaultTitle(providerID: string) {
  return providerID
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
}

function buildOAuthExcludedModels(value: unknown, disabledOAuthProviderKeys: string[]) {
  const base = stringKeyedDictionary(value) ?? {}
  const merged: Dict = { ...base }

  for (const providerKey of [...disabledOAuthProviderKeys].sort()) {
    const existing = Array.isArray(merged[providerKey]) ? [...merged[providerKey] as unknown[]] : []
    const normalized = existing.filter((entry): entry is string => typeof entry === 'string')
    if (!normalized.includes('*')) {
      normalized.push('*')
    }
    merged[providerKey] = normalized
  }

  return Object.keys(merged).length === 0 ? undefined : merged
}

export function composeAdditiveBaseConfig(bundledRoot: Record<string, unknown>, userRoot?: Record<string, unknown>) {
  return userRoot ? mergeDictionary(bundledRoot, userRoot) : bundledRoot
}

export function parseCustomProviders(root: Record<string, unknown>, reservedProviderIDs: Set<string>): CustomProviderDefinition[] {
  return stringKeyedDictionaryArray(root['openai-compatibility'])
    .flatMap((entry) => {
      const providerID = normalizedProviderID(entry)
      if (!providerID || reservedProviderIDs.has(providerID)) {
        return []
      }

      const modelAliases = stringKeyedDictionaryArray(entry.models).flatMap((model) => {
        const alias = typeof model.alias === 'string' ? model.alias : typeof model.name === 'string' ? model.name : undefined
        return alias ? [alias] : []
      })

      return [{
        id: providerID,
        title: typeof entry['display-name'] === 'string' ? entry['display-name'] : defaultTitle(providerID),
        baseURL: normalizedString(entry['base-url']) ?? '',
        helpText: typeof entry['help-text'] === 'string' ? entry['help-text'] : undefined,
        iconSystemName: typeof entry['icon-system'] === 'string' ? entry['icon-system'] : undefined,
        modelAliases,
        inlineAPIKeys: deduplicatedAPIKeys(entry)
      } satisfies CustomProviderDefinition]
    })
    .sort((left, right) => left.title.localeCompare(right.title))
}

export function validateCustomProviders(root: Record<string, unknown>, reservedProviderIDs: Set<string>): string[] {
  const rawOpenAICompatibility = root['openai-compatibility']
  if (rawOpenAICompatibility === undefined) {
    return []
  }

  if (!Array.isArray(rawOpenAICompatibility)) {
    return ['openai-compatibility must be an array of provider mappings.']
  }

  const errors: string[] = []
  const seenProviderIDs = new Set<string>()

  rawOpenAICompatibility.forEach((rawEntry, index) => {
    const path = `openai-compatibility[${index}]`
    const entry = stringKeyedDictionary(rawEntry)
    if (!entry) {
      errors.push(`${path} must be a mapping.`)
      return
    }

    const rawProviderName = entry.name
    if (typeof rawProviderName !== 'string') {
      errors.push(`${path} must define a string name.`)
      return
    }

    const providerID = normalizedString(rawProviderName)
    if (!providerID) {
      errors.push(`${path} must define a non-empty name.`)
      return
    }

    if (rawProviderName !== providerID) {
      errors.push(`Provider name '${rawProviderName}' must not include leading or trailing whitespace.`)
      return
    }

    if (seenProviderIDs.has(providerID)) {
      errors.push(`Duplicate openai-compatibility provider '${providerID}' is not allowed.`)
    } else {
      seenProviderIDs.add(providerID)
    }

    if (reservedProviderIDs.has(providerID)) {
      errors.push(`Provider '${providerID}' is reserved and cannot be declared under openai-compatibility.`)
      return
    }

    if (entry.models !== undefined) {
      errors.push(...validateMappingArray(entry.models, `${path}.models`))
    }

    if (entry['api-key-entries'] !== undefined) {
      if (!Array.isArray(entry['api-key-entries'])) {
        errors.push(`${path}.api-key-entries must be an array of mappings.`)
      } else {
        stringKeyedDictionaryArray(entry['api-key-entries']).forEach((apiKeyEntry, apiKeyIndex) => {
          if (!normalizedString(apiKeyEntry['api-key'])) {
            errors.push(`${path}.api-key-entries[${apiKeyIndex}] must define a non-empty api-key.`)
          }
        })
      }
    }

    if (!normalizedString(entry['base-url'])) {
      errors.push(`Custom provider '${providerID}' must define a non-empty base-url.`)
    }
  })

  return errors
}

export function composeRuntimeConfig(baseRoot: Record<string, unknown>, options: ComposeRuntimeConfigOptions) {
  const mergedRoot: Dict = { ...baseRoot }
  const oauthExcludedModels = buildOAuthExcludedModels(mergedRoot['oauth-excluded-models'], options.disabledOAuthProviderKeys)
  if (oauthExcludedModels) {
    mergedRoot['oauth-excluded-models'] = oauthExcludedModels
  } else {
    delete mergedRoot['oauth-excluded-models']
  }

  const managedCustomProviderIDs = new Set(parseCustomProviders(baseRoot, options.reservedCustomProviderKeys).map((provider) => provider.id))
  const authEntriesByProviderID = new Map<string, Array<{ 'api-key': string }>>()
  options.customProviderAuthRecords.filter((record) => !record.isDisabled).forEach((record) => {
    const existing = authEntriesByProviderID.get(record.providerID) ?? []
    existing.push({ 'api-key': record.apiKey })
    authEntriesByProviderID.set(record.providerID, existing)
  })

  const mergedOpenAICompatibility: Dict[] = []
  for (const entry of stringKeyedDictionaryArray(mergedRoot['openai-compatibility'])) {
    const providerName = normalizedProviderID(entry)
    if (!providerName) {
      continue
    }

    if (options.disabledCustomProviderIDs.has(providerName)) {
      continue
    }

    const sanitizedEntry = stripCustomProviderUIMetadata({ ...entry, name: providerName })
    if (managedCustomProviderIDs.has(providerName)) {
      const inlineEntries = apiKeyEntries(entry)
      const authEntries = authEntriesByProviderID.get(providerName) ?? []
      const effectiveEntries = deduplicatedAPIKeyEntries([...inlineEntries, ...authEntries])
      if (effectiveEntries.length === 0) {
        continue
      }

      sanitizedEntry['api-key-entries'] = effectiveEntries
    }

    mergedOpenAICompatibility.push(sanitizedEntry)
  }

  if (mergedOpenAICompatibility.length === 0) {
    delete mergedRoot['openai-compatibility']
  } else {
    mergedRoot['openai-compatibility'] = mergedOpenAICompatibility
  }

  return mergedRoot
}
