import type { DirectCommandHandler } from '../handlers.js'

export const handle: DirectCommandHandler = ctx => ({
  text: [
    'Messages you send here route to a paired Claude Code session. Text, photos, and supported attachments are forwarded; replies and reactions come back.',
    '',
    'Available commands:',
    ...ctx.registry
      .filter(command => command.enabled)
      .map(command => `/${command.name} — ${command.description}`),
  ].join('\n'),
})
