import type { DirectCommandHandler } from '../handlers.js'

export const handle: DirectCommandHandler = ctx => ({
  text: [
    'Available commands:',
    ...ctx.registry
      .filter(command => command.enabled)
      .map(command => `/${command.name} — ${command.description}`),
  ].join('\n'),
})
