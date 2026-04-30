/**
 * `viberelay relaymind doctor` — diagnostic report.
 *
 * Runs the verifier and prints a PASS/FAIL summary plus the list of issues.
 * Exit code is left to the registrar; this command always returns a string
 * so the caller can render it however they like.
 *
 * The tmux availability probe lives here (not in profile-installer's
 * verifyInstallation) because tmux is a host-machine prerequisite, not a
 * property of the on-disk profile — installing/repairing the profile can't
 * fix a missing tmux binary, so the diagnostic should surface separately.
 */

import { relayMindPaths } from '@viberelay/shared/relaymind'
import { verifyInstallation } from '../../lib/profile-installer.js'
import { tmuxAvailable } from '../../lib/supervisor.js'
import { checkDep } from '../../lib/deps.js'

const HELP = `viberelay relaymind doctor

  Runs the installation verifier and prints a PASS/FAIL summary with any
  issues found. No side effects — read-only diagnostic.

Usage:
  viberelay relaymind doctor   Run diagnostics and show health report

Examples:
  viberelay relaymind doctor`

export default async function doctor(argv: string[]): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return HELP
  }
  const paths = relayMindPaths(process.cwd())
  const v = await verifyInstallation(paths)
  const issues = [...v.issues]

  if (!(await tmuxAvailable())) {
    issues.push(
      "tmux: not found on PATH (install: 'brew install tmux' on macOS, 'apt install tmux' on Linux)",
    )
  }

  const claudeDep = await checkDep('claude')
  if (!claudeDep.ok) {
    issues.push(`claude: not found on PATH (install: ${claudeDep.hint})`)
  }

  const lines: string[] = ['viberelay relaymind doctor']
  lines.push(`profile root: ${paths.claudeHome}`)
  lines.push('')

  if (issues.length === 0) {
    lines.push('PASS — installation looks healthy.')
    return lines.join('\n')
  }

  lines.push(`FAIL — ${issues.length} issue(s):`)
  for (const issue of issues) lines.push(`  · ${issue}`)
  lines.push('')
  lines.push('repair:  viberelay relaymind setup')
  return lines.join('\n')
}
