/**
 * `viberelay relaymind self <subcommand>` — self-maintenance surface.
 *
 * Exposed to Claude so it can validate its own edits and request rollback
 * when the supervisor flags an unhealthy restart (PRD §831-866).
 *
 * Subcommands:
 *   self validate
 *     Runs typecheck + verifyInstallation + doctor. Prints PASS/FAIL with
 *     the first failing detail. Used as the gate before requesting restart.
 *   self snapshot
 *     Wrapper around supervisor.snapshotRegistry — captures the current
 *     command registry as last-known-good.
 *   self rollback
 *     Wrapper around supervisor.rollbackRegistry. PRD §867 — never silently
 *     no-ops; throws verbatim if no snapshot exists.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { relayMindPaths } from '@viberelay/shared/relaymind'
import { verifyInstallation } from '../../lib/profile-installer.js'
import { rollbackRegistry, snapshotRegistry } from '../../lib/supervisor.js'
import doctor from './doctor.js'

const HELP = `viberelay relaymind self <subcommand>

  validate    Validate profile + typecheck + doctor before requesting restart
  snapshot    Snapshot the current command registry as last-known-good
  rollback    Restore the last-known-good command registry (destructive)`

interface RunResult {
  ok: boolean
  /** First-line summary. */
  summary: string
  /** Optional detail (multi-line). */
  detail?: string
}

function findRepoRoot(): string {
  // Walk up from CWD looking for `tsconfig.base.json`. The profile installer
  // resolves the plugin bundle the same way (via import.meta.url) — but the
  // typecheck must run against the user's repo, not the bundled CLI source.
  let cur = process.cwd()
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(cur, 'tsconfig.base.json')
    if (existsSync(candidate)) return cur
    const next = path.dirname(cur)
    if (next === cur) break
    cur = next
  }
  return process.cwd()
}

async function runTypecheck(): Promise<RunResult> {
  const repoRoot = findRepoRoot()
  return new Promise<RunResult>((resolve) => {
    const child = spawn('bunx', ['tsc', '--noEmit', '-p', 'tsconfig.base.json'], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('error', (e) => {
      // Most likely `bunx` not on PATH — fall through with a clear note.
      resolve({
        ok: false,
        summary: 'typecheck: failed to spawn bunx',
        detail: e.message,
      })
    })
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true, summary: 'typecheck: PASS' })
      } else {
        const combined = `${out}${err}`.trim()
        const firstError = combined.split('\n').find((l) => l.includes('error')) ?? combined.slice(0, 240)
        resolve({
          ok: false,
          summary: 'typecheck: FAIL',
          detail: firstError || `tsc exited with code ${code}`,
        })
      }
    })
  })
}

async function runValidate(): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const lines: string[] = ['viberelay relaymind self validate']

  // 1. Typecheck.
  const tc = await runTypecheck()
  lines.push(`  [${tc.ok ? 'OK ' : 'FAIL'}] ${tc.summary}`)
  if (!tc.ok && tc.detail) lines.push(`        · ${tc.detail}`)

  // 2. Verify installation (deep check).
  const v = await verifyInstallation(paths)
  lines.push(`  [${v.ok ? 'OK ' : 'FAIL'}] verifyInstallation — ${v.ok ? 'all paths present' : `${v.issues.length} issue(s)`}`)
  if (!v.ok) {
    for (const issue of v.issues.slice(0, 5)) lines.push(`        · ${issue}`)
  }

  // 3. Doctor (string-level PASS/FAIL).
  const doc = await doctor([])
  const doctorOk = doc.includes('PASS')
  lines.push(`  [${doctorOk ? 'OK ' : 'FAIL'}] doctor`)
  if (!doctorOk) {
    const firstFail = doc.split('\n').find((l) => l.includes('·')) ?? ''
    if (firstFail) lines.push(`        ${firstFail.trim()}`)
  }

  const ok = tc.ok && v.ok && doctorOk
  lines.push('')
  lines.push(ok ? 'PASS' : 'FAIL')
  return lines.join('\n')
}

async function runSnapshot(): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  const wrote = await snapshotRegistry(paths)
  if (!wrote) {
    return 'viberelay relaymind self snapshot\n  [WARN] nothing to snapshot — registry.json missing'
  }
  return `viberelay relaymind self snapshot\n  [OK ] snapshot written to ${paths.lastGoodRegistry}`
}

async function runRollback(): Promise<string> {
  const paths = relayMindPaths(process.cwd())
  // Per PRD §867 rollback must never silently no-op. supervisor throws when
  // there's no snapshot; we surface it verbatim.
  await rollbackRegistry(paths)
  return `viberelay relaymind self rollback\n  [OK ] restored ${paths.registryJson} from ${paths.lastGoodRegistry}`
}

export default async function self(argv: string[]): Promise<string> {
  const sub = argv[0]
  switch (sub) {
    case 'validate':
      return runValidate()
    case 'snapshot':
      return runSnapshot()
    case 'rollback':
      return runRollback()
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return HELP
    default:
      return `viberelay relaymind self ${sub}: unknown subcommand.\n\n${HELP}`
  }
}
