/**
 * File-mirror helper for the telegram channel plugin.
 *
 * Lives in its own module — separate from server.ts — so tests can import
 * it without booting the whole server (which has top-level side effects:
 * grammy Bot creation, env load, polling IIFE).
 *
 * The relaymind bridge (`viberelay relaymind bridge`) reads files written
 * here. See packages/cli/src/lib/telegram-bridge.ts.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MirrorMeta {
  chat_id: string
  message_id?: string
  user: string
  user_id: string
  ts: string
  image_path?: string
  attachment_kind?: string
  attachment_file_id?: string
  attachment_size?: string
  attachment_mime?: string
  attachment_name?: string
}

/**
 * Atomically write an inbound-message mirror file under <rootDir>/messages/.
 * The file shape mirrors the `notifications/claude/channel` params so the
 * bridge worker reads the exact same structure Claude would have seen.
 */
export function mirrorInboundMessage(
  rootDir: string,
  content: string,
  meta: MirrorMeta,
): string {
  const dir = join(rootDir, 'messages')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const idPart = meta.message_id ?? 'nomsg'
  const fname = `${idPart}.${Date.now()}.json`
  const target = join(dir, fname)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify({ content, meta }, null, 2), { mode: 0o600 })
  renameSync(tmp, target)
  return target
}
