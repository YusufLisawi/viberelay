import type { DirectCommandHandler } from '../handlers.js'

export const handle: DirectCommandHandler = () => ({
  text: [
    'This bot bridges Telegram to a Claude Code session.',
    '',
    'To pair:',
    "1. DM me anything — you'll get a 6-char code",
    '2. In Claude Code: /telegram:access pair <code>',
    '',
    'After that, DMs here reach that session.',
  ].join('\n'),
})
