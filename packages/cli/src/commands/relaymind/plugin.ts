/**
 * `viberelay relaymind plugin <install|verify>` — thin aliases.
 *
 * `plugin install` re-runs setup; `plugin verify` runs doctor. They exist
 * because the PRD §415 namespace promises them and skills/docs reference
 * them — keeping them as routers avoids divergence from setup/doctor logic.
 */

import setup from './setup.js'
import doctor from './doctor.js'

const HELP = `viberelay relaymind plugin <subcommand>

  install     Install or repair the RelayMind profile (alias for setup)
  verify      Verify installation health (alias for doctor)`

export default async function plugin(argv: string[]): Promise<string> {
  const sub = argv[0]
  const rest = argv.slice(1)
  switch (sub) {
    case 'install':
      return setup(rest)
    case 'verify':
      return doctor(rest)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return HELP
    default:
      return `viberelay relaymind plugin ${sub}: unknown subcommand.\n\n${HELP}`
  }
}
