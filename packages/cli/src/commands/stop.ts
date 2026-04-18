export interface StopCommandOptions {
  baseUrl: string
}

export async function runStopCommand(options: StopCommandOptions) {
  const response = await fetch(`${options.baseUrl}/relay/stop`, { method: 'POST' })
  const payload = await response.json() as { state: string }
  return `viberelay ${payload.state}`
}
