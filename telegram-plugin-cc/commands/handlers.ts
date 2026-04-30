import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { TelegramCommandEntry } from '../command-registry.js'

export type DirectCommandResult = {
  text: string
}

export type DirectCommandContext = {
  args: string
  access: {
    allowFrom: string[]
    pending: Record<string, { senderId: string }>
  }
  senderId: string
  username?: string
  registry: TelegramCommandEntry[]
}

export type DirectCommandHandler = (ctx: DirectCommandContext) => Promise<DirectCommandResult> | DirectCommandResult

type DirectCommandModule = {
  handle?: DirectCommandHandler
}

const HANDLER_DIR = fileURLToPath(new URL('./handlers/', import.meta.url))

export async function loadDirectCommandHandler(handler: string): Promise<DirectCommandHandler | undefined> {
  const handlerName = handler.trim()
  if (!/^[a-z][a-z0-9_-]*$/.test(handlerName)) return undefined

  const path = join(HANDLER_DIR, `${handlerName}.ts`)
  if (!existsSync(path)) return undefined

  const module = await import(`${pathToFileURL(path).href}?t=${Date.now()}`) as DirectCommandModule
  return typeof module.handle === 'function' ? module.handle : undefined
}
