export interface StartCommandOptions {
  baseUrl: string
}

export async function runStartCommand(options: StartCommandOptions) {
  const response = await fetch(`${options.baseUrl}/relay/start`, { method: 'POST' })
  const payload = await response.json() as { state: string }
  return `viberelay ${payload.state}`
}
