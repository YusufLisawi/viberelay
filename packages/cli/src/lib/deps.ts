/**
 * Host-machine dependency probes for RelayMind setup.
 *
 * Two third-party binaries are mandatory: `tmux` (the supervisor's PTY host)
 * and `claude` (Anthropic's Claude Code CLI — even when the supervisor
 * dispatches via `viberelay run`, the run path ultimately spawns claude).
 *
 * Three pure-ish functions:
 *   - `checkDep(bin)` — version probe, no side effects.
 *   - `tryAutoInstall(bin)` — best-effort install via brew/apt; never runs
 *     `sudo` silently, exits with a hint when it cannot proceed.
 *   - `installCommandHint(bin)` — platform-appropriate user-runnable string.
 *
 * Hard rules: Node stdlib only, no `any`, no shell strings — argv arrays
 * passed to `execFile` so user-controlled values cannot inject metachars.
 */

import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type SupportedDep = 'tmux' | 'claude'

export type DepCheckResult =
  | { ok: true; version: string }
  | { ok: false; hint: string }

export type AutoInstallResult = {
  installed: boolean
  reason: string
}

/**
 * Resolved version-probe argv for each supported dep. Both binaries accept
 * a short version flag and exit 0 quickly — no subprocess pollution.
 */
const VERSION_PROBE: Readonly<Record<SupportedDep, readonly string[]>> = {
  tmux: ['-V'],
  claude: ['--version'],
}

export interface CheckDepOpts {
  /**
   * Injected for tests. Receives the binary name + its argv and returns the
   * captured streams. Real callers leave this unset (we use execFile).
   */
  exec?: (bin: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
}

/** Probe a dependency by running its version command. */
export async function checkDep(bin: SupportedDep, opts: CheckDepOpts = {}): Promise<DepCheckResult> {
  const runner = opts.exec ?? ((b: string, args: readonly string[]) => execFileAsync(b, [...args]))
  try {
    const { stdout, stderr } = await runner(bin, VERSION_PROBE[bin])
    const version = (stdout || stderr).trim().split('\n')[0] ?? ''
    return { ok: true, version: version || `${bin} (version unknown)` }
  } catch {
    return { ok: false, hint: installCommandHint(bin) }
  }
}

/**
 * Platform-appropriate install command for the user. Used when auto-install
 * is unavailable or declined.
 */
export function installCommandHint(bin: SupportedDep): string {
  if (bin === 'claude') return 'npm install -g @anthropic-ai/claude-code'
  // tmux
  if (process.platform === 'darwin') return 'brew install tmux'
  if (process.platform === 'linux') return 'sudo apt install tmux'
  return `install ${bin} via your package manager`
}

interface PackageManagerInfo {
  manager: 'brew' | 'apt' | 'apt-get' | null
  needsSudo: boolean
}

async function detectPackageManager(
  exec: (bin: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<PackageManagerInfo> {
  if (process.platform === 'darwin') {
    try {
      await exec('brew', ['--version'])
      return { manager: 'brew', needsSudo: false }
    } catch {
      return { manager: null, needsSudo: false }
    }
  }
  if (process.platform === 'linux') {
    for (const mgr of ['apt', 'apt-get'] as const) {
      try {
        await exec(mgr, ['--version'])
        // apt always wants root unless we're already root.
        const needsSudo = process.getuid?.() !== 0
        return { manager: mgr, needsSudo }
      } catch {
        // try next
      }
    }
  }
  return { manager: null, needsSudo: false }
}

export interface AutoInstallOpts extends CheckDepOpts {
  /**
   * Caller must pass `force: true` to actually run the install. Without it,
   * tryAutoInstall is a dry-run that explains what *would* happen — this
   * mirrors the `--auto-install` user flag contract: nothing is installed
   * unless the user explicitly asked.
   */
  force?: boolean
}

/**
 * Best-effort auto-install. Only `npm`-installable claude and `brew`/`apt`-
 * installable tmux are supported. Refuses to run sudo silently — if apt
 * needs root, returns `installed=false` with the exact command for the
 * user to run.
 */
export async function tryAutoInstall(bin: SupportedDep, opts: AutoInstallOpts = {}): Promise<AutoInstallResult> {
  const exec = opts.exec ?? ((b: string, args: readonly string[]) => execFileAsync(b, [...args]))
  if (!opts.force) {
    return { installed: false, reason: `auto-install not requested (re-run with --auto-install to install ${bin})` }
  }

  if (bin === 'claude') {
    try {
      await exec('npm', ['install', '-g', '@anthropic-ai/claude-code'])
      const re = await checkDep(bin, { exec })
      return re.ok
        ? { installed: true, reason: `installed via npm: ${re.version}` }
        : { installed: false, reason: 'npm install completed but claude is still not on PATH' }
    } catch (err) {
      return { installed: false, reason: `npm install failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  // tmux
  const pm = await detectPackageManager(exec)
  if (!pm.manager) {
    return { installed: false, reason: `no supported package manager found — install manually: ${installCommandHint(bin)}` }
  }
  if (pm.manager === 'brew') {
    try {
      await exec('brew', ['install', 'tmux'])
      const re = await checkDep(bin, { exec })
      return re.ok
        ? { installed: true, reason: `installed via brew: ${re.version}` }
        : { installed: false, reason: 'brew install completed but tmux is still not on PATH' }
    } catch (err) {
      return { installed: false, reason: `brew install failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  // apt / apt-get
  if (pm.needsSudo) {
    return {
      installed: false,
      reason: `apt requires root — run: sudo ${pm.manager} install -y tmux  (then re-run relaymind init)`,
    }
  }
  try {
    await exec(pm.manager, ['install', '-y', 'tmux'])
    const re = await checkDep(bin, { exec })
    return re.ok
      ? { installed: true, reason: `installed via ${pm.manager}: ${re.version}` }
      : { installed: false, reason: `${pm.manager} install completed but tmux is still not on PATH` }
  } catch (err) {
    return { installed: false, reason: `${pm.manager} install failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── Helper used by init/setup/doctor ─────────────────────────────────────────

export interface DepReport {
  bin: SupportedDep
  result: DepCheckResult
}

/** Run all required dep checks. Test-injectable via `opts.exec`. */
export async function checkAllDeps(opts: CheckDepOpts = {}): Promise<DepReport[]> {
  const bins: SupportedDep[] = ['tmux', 'claude']
  const reports: DepReport[] = []
  for (const bin of bins) {
    reports.push({ bin, result: await checkDep(bin, opts) })
  }
  return reports
}
