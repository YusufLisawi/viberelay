function parseBody(jsonString: string) {
  return JSON.parse(jsonString) as Record<string, unknown>
}

function serializeBody(json: Record<string, unknown>) {
  return JSON.stringify(json)
}

function getModel(json: Record<string, unknown>) {
  return typeof json.model === 'string' ? json.model : undefined
}

export function processThinkingParameter(jsonString: string) {
  const json = parseBody(jsonString)
  const model = getModel(json)
  if (!model) {
    return undefined
  }

  const match = model.match(/^(.*)-thinking-(\d+)$/)
  if (!match) {
    return undefined
  }

  json.model = match[1]
  json.thinking = {
    type: 'enabled',
    budget_tokens: Number(match[2])
  }

  return {
    body: serializeBody(json),
    thinkingEnabled: true
  }
}

export function processEffortLevel(jsonString: string) {
  const json = parseBody(jsonString)
  const model = getModel(json)
  if (!model) {
    return undefined
  }

  const match = model.match(/^(.*)-effort-(low|medium|high|max)$/)
  if (!match) {
    return undefined
  }

  json.model = match[1]
  json.output_config = { effort: match[2] }
  return serializeBody(json)
}

export function processReasoningEffort(jsonString: string) {
  const json = parseBody(jsonString)
  const model = getModel(json)
  if (!model || model.startsWith('claude-')) {
    return undefined
  }

  const match = model.match(/^(.*)-reasoning-(low|medium|high)$/)
  if (!match) {
    return undefined
  }

  json.model = match[1]
  json.reasoning = { effort: match[2] }
  return serializeBody(json)
}

export function stripResidualModelSuffixes(jsonString: string) {
  const json = parseBody(jsonString)
  const model = getModel(json)
  if (!model) {
    return undefined
  }

  if (model.endsWith('-thinking')) {
    json.model = model.slice(0, -'-thinking'.length)
    return {
      body: serializeBody(json),
      suffix: 'thinking'
    }
  }

  return undefined
}

export function stripThinkingBlocks(jsonString: string) {
  const json = parseBody(jsonString)
  const messages = Array.isArray(json.messages) ? json.messages : undefined
  if (!messages) {
    return undefined
  }

  let modified = false
  const nextMessages = messages.map((message) => {
    if (!message || typeof message !== 'object') {
      return message
    }

    const content = Array.isArray((message as { content?: unknown }).content)
      ? (message as { content: Array<Record<string, unknown>> }).content
      : undefined
    if (!content) {
      return message
    }

    const filtered = content.filter((block) => block.type !== 'thinking')
    if (filtered.length !== content.length) {
      modified = true
      return { ...(message as Record<string, unknown>), content: filtered }
    }

    return message
  })

  if (!modified) {
    return undefined
  }

  json.messages = nextMessages
  return serializeBody(json)
}
