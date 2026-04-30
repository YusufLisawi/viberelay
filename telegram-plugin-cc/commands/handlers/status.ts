import type { DirectCommandHandler } from '../handlers.js'

export const handle: DirectCommandHandler = ctx => {
  if (ctx.access.allowFrom.includes(ctx.senderId)) {
    const name = ctx.username ? `@${ctx.username}` : ctx.senderId
    return { text: `Paired as ${name}.` }
  }

  for (const [code, pending] of Object.entries(ctx.access.pending)) {
    if (pending.senderId === ctx.senderId) {
      return { text: `Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}` }
    }
  }

  return { text: 'Not paired. Send me a message to get a pairing code.' }
}
