import { isConnectionRefused } from '../lib/daemon-control.js'

export interface DaemonStatusPayload {
  generated_at: string
  proxy: {
    host: string
    port: number
    target_port: number
    running: boolean
  }
  accounts: {
    total: number
    active: number
    expired: number
  }
}

export interface StatusCommandOptions {
  baseUrl: string
}

export async function runStatusCommand(options: StatusCommandOptions) {
  try {
    const response = await fetch(`${options.baseUrl}/status`)
    const status = (await response.json()) as DaemonStatusPayload
    return `viberelay ${status.proxy.running ? 'running' : 'stopped'} on ${status.proxy.host}:${status.proxy.port} (accounts ${status.accounts.active}/${status.accounts.total})`
  } catch (error) {
    if (isConnectionRefused(error)) {
      return 'viberelay-daemon not running — start it with: viberelay start'
    }
    throw error
  }
}
