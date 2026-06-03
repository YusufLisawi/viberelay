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

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DIST_DIR = join(REPO_ROOT, 'dist')
const RESOURCES_DIR = join(REPO_ROOT, 'resources')

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

async function copyDir(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true })
  for (const entry of await readdir(src)) {
    const srcPath = join(src, entry)
    const dstPath = join(dst, entry)
    const info = await stat(srcPath)
    if (info.isDirectory()) {
      await copyDir(srcPath, dstPath)
    } else {
      await copyFile(srcPath, dstPath)
    }
  }
}

/**
 * Stage runtime resources (the cli-proxy-api child, config.yaml, icons,
 * static dashboard assets) next to the compiled binaries.
 *
 * A compiled daemon anchors `bundledBinaryPath` on `resolve(dirname(execPath),
 * '..')` — i.e. `dist/` when running `dist/host/viberelay-daemon`. Without this
 * copy the daemon crashes on start with `ENOENT … dist/resources/cli-proxy-api`.
 * (Release archives stage resources per-payload in package-release.ts; this
 * keeps a plain local `bun run build` runnable too.)
 */
async function stageResources(): Promise<void> {
  console.log('→ staging resources → dist/resources')
  await copyDir(RESOURCES_DIR, join(DIST_DIR, 'resources'))
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
  await stageResources()
  console.log(`✓ built ${targets.join(', ')} → ${DIST_DIR}`)
}

await main()
