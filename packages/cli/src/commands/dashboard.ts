import { openUrl } from '../lib/open-url.js'

export interface DashboardCommandOptions {
  baseUrl: string
  openUrl?: (url: string) => Promise<void>
}

export async function runDashboardCommand(options: DashboardCommandOptions) {
  const url = `${options.baseUrl}/dashboard`
  await (options.openUrl ?? openUrl)(url)
  return `opened ${url}`
}
