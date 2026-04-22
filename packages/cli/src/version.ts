import rootPkg from '../../../package.json' with { type: 'json' }

export const VERSION = (rootPkg as { version: string }).version
export const UPSTREAM_REPO = 'YusufLisawi/viberelay'
