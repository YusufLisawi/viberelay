#!/usr/bin/env bun
/**
 * Compile viberelay CLI + daemon into standalone binaries using Bun.
 *
 *   bun run scripts/build.ts                       # host target
 *   bun run scripts/build.ts --target bun-linux-x64
 *   bun run scripts/build.ts --all                 # every supported target
 *
 * Outputs to ./dist/<target>/{viberelay,viberelay-daemon}[.exe]
 */

import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DIST_DIR = join(REPO_ROOT, 'dist')

const TARGETS = [
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64'
] as const

type Target = typeof TARGETS[number] | 'host'

interface Artifact {
  name: string
  entry: string
}

const ARTIFACTS: Artifact[] = [
  { name: 'viberelay', entry: 'packages/cli/src/bin.ts' },
  { name: 'viberelay-daemon', entry: 'packages/daemon/src/runner.ts' }
  // Note: there is no separate `relaymind` artifact. The same `viberelay`
  // binary is renamed to `relaymind` by scripts/package-relaymind.ts and
  // routed via basename detection inside bin.ts.
]

function parseArgs(argv: string[]): { targets: Target[] } {
  const args = argv.slice(2)
  if (args.includes('--all')) return { targets: [...TARGETS] }
  const targetIdx = args.indexOf('--target')
  if (targetIdx >= 0) {
    const value = args[targetIdx + 1]
    if (!value) throw new Error('--target requires a value')
    if (value !== 'host' && !TARGETS.includes(value as typeof TARGETS[number])) {
      throw new Error(`unknown target ${value}. Known: ${TARGETS.join(', ')}`)
    }
    return { targets: [value as Target] }
  }
  return { targets: ['host'] }
}

async function build(target: Target): Promise<void> {
  const outDir = join(DIST_DIR, target === 'host' ? 'host' : target)
  await mkdir(outDir, { recursive: true })

  for (const artifact of ARTIFACTS) {
    const ext = target.includes('windows') ? '.exe' : ''
    const outFile = join(outDir, `${artifact.name}${ext}`)
    const entry = join(REPO_ROOT, artifact.entry)
    const targetFlag = target === 'host' ? [] : ['--target', target]
    console.log(`→ compiling ${artifact.name} (${target})`)
    await $`bun build ${entry} --compile ${targetFlag} --outfile ${outFile}`.cwd(REPO_ROOT)
  }
}

async function main(): Promise<void> {
  const { targets } = parseArgs(process.argv)
  await rm(DIST_DIR, { recursive: true, force: true })
  for (const target of targets) {
    await build(target)
  }
  console.log(`✓ built ${targets.join(', ')} → ${DIST_DIR}`)
}

await main()
