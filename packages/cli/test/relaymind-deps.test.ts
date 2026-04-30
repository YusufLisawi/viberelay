import { describe, expect, it } from 'vitest'

import {
  checkAllDeps,
  checkDep,
  installCommandHint,
  tryAutoInstall,
  type SupportedDep,
} from '../src/lib/deps.js'

// ── Exec stub helpers ────────────────────────────────────────────────────────

interface StubResult {
  stdout?: string
  stderr?: string
  err?: Error
}

function makeExec(map: Record<string, StubResult | ((args: readonly string[]) => StubResult)>) {
  const calls: Array<{ bin: string; args: readonly string[] }> = []
  const fn = async (bin: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ bin, args })
    const entry = map[bin]
    const result = typeof entry === 'function' ? entry(args) : entry
    if (!result || result.err) {
      throw result?.err ?? new Error(`stub: no entry for ${bin}`)
    }
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  return { fn, calls }
}

// ── checkDep ─────────────────────────────────────────────────────────────────

describe('deps.checkDep', () => {
  it('returns ok with parsed version when the binary succeeds', async () => {
    const exec = makeExec({ tmux: { stdout: 'tmux 3.4\n' } })
    const r = await checkDep('tmux', { exec: exec.fn })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.version).toBe('tmux 3.4')
  })

  it('returns hint when the binary throws (e.g. ENOENT)', async () => {
    const exec = makeExec({ claude: { err: new Error('ENOENT') } })
    const r = await checkDep('claude', { exec: exec.fn })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.hint).toContain('@anthropic-ai/claude-code')
  })

  it('falls back to stderr when stdout is empty', async () => {
    const exec = makeExec({ claude: { stdout: '', stderr: 'claude 0.5.0\n' } })
    const r = await checkDep('claude', { exec: exec.fn })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.version).toBe('claude 0.5.0')
  })
})

// ── checkAllDeps ─────────────────────────────────────────────────────────────

describe('deps.checkAllDeps', () => {
  it('reports both deps; missing ones surface as not-ok with hint', async () => {
    const exec = makeExec({
      tmux: { stdout: 'tmux 3.4\n' },
      claude: { err: new Error('ENOENT') },
    })
    const reports = await checkAllDeps({ exec: exec.fn })
    expect(reports.map((r) => r.bin)).toEqual(['tmux', 'claude'])
    expect(reports[0]!.result.ok).toBe(true)
    expect(reports[1]!.result.ok).toBe(false)
  })
})

// ── installCommandHint ───────────────────────────────────────────────────────

describe('deps.installCommandHint', () => {
  it('returns the npm install command for claude regardless of platform', () => {
    expect(installCommandHint('claude')).toContain('@anthropic-ai/claude-code')
  })

  it('returns a tmux install command for tmux', () => {
    const bins: SupportedDep[] = ['tmux']
    for (const bin of bins) {
      expect(installCommandHint(bin)).toMatch(/tmux/)
    }
  })
})

// ── tryAutoInstall ───────────────────────────────────────────────────────────

describe('deps.tryAutoInstall', () => {
  it('refuses without force=true (dry-run hint)', async () => {
    const exec = makeExec({})
    const r = await tryAutoInstall('tmux', { exec: exec.fn })
    expect(r.installed).toBe(false)
    expect(r.reason).toContain('auto-install not requested')
  })

  it('claude: succeeds when npm install + check succeed', async () => {
    const exec = makeExec({
      npm: { stdout: 'added 1 package' },
      claude: { stdout: 'claude 0.5.0\n' },
    })
    const r = await tryAutoInstall('claude', { exec: exec.fn, force: true })
    expect(r.installed).toBe(true)
    expect(r.reason).toContain('claude 0.5.0')
  })

  it('claude: surfaces npm failure', async () => {
    const exec = makeExec({ npm: { err: new Error('EACCES') } })
    const r = await tryAutoInstall('claude', { exec: exec.fn, force: true })
    expect(r.installed).toBe(false)
    expect(r.reason).toContain('npm install failed')
  })

  it('tmux: returns clear error when no package manager is detected', async () => {
    // No brew/apt entries — every probe throws.
    const exec = makeExec({})
    const r = await tryAutoInstall('tmux', { exec: exec.fn, force: true })
    expect(r.installed).toBe(false)
    expect(r.reason.toLowerCase()).toContain('install')
  })
})
