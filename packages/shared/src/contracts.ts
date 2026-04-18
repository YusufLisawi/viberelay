export interface HealthPayload {
  ok: true
  service: 'viberelay'
}

export interface DaemonStatusPayload {
  running: boolean
  pid: number | null
  childPid: number | null
  host: string
  port: number
}
