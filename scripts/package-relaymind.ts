#!/usr/bin/env bun
/**
 * Package the relaymind binary into a distributable archive.
 *
 *   bun run scripts/package-relaymind.ts --target bun-darwin-arm64
 *
 * Produces: ./dist/archives/relaymind-<target>.tar.gz
 *
 * Supported targets: bun-darwin-x64, bun-darwin-arm64,
 *                    bun-linux-x64,  bun-linux-arm64
 * Windows is explicitly rejected — relaymind is darwin/linux only.
 */

import { mkdir, copyFile, readdir, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { $ } from 'bun'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DIST_DIR = join(REPO_ROOT, 'dist')
const ARCHIVE_DIR = join(DIST_DIR, 'archives')

const SUPPORTED_TARGETS = [
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-linux-x64',
  'bun-linux-arm64',
] as const

type SupportedTarget = typeof SUPPORTED_TARGETS[number]

interface CliArgs { target: string }

function parseArgs(argv: string[]): CliArgs {
  const idx = argv.indexOf('--target')
  if (idx < 0 || !argv[idx + 1]) throw new Error('--target <bun-target> required')
  return { target: argv[idx + 1]! }
}

function assertSupportedTarget(target: string): asserts target is SupportedTarget {
  if (target.includes('windows')) {
    throw new Error(
      `relaymind does not support Windows targets (got: ${target}).\n` +
      `Windows support is not planned — relaymind is darwin/linux only.\n` +
      `For the full viberelay suite on Windows, use scripts/package-release.ts instead.`
    )
  }
  if (!SUPPORTED_TARGETS.includes(target as SupportedTarget)) {
    throw new Error(
      `Unknown target: ${target}\n` +
      `Supported targets: ${SUPPORTED_TARGETS.join(', ')}`
    )
  }
}

async function main(): Promise<void> {
  const { target } = parseArgs(process.argv)
  assertSupportedTarget(target)

  const binDir = join(DIST_DIR, target)
  const stageDir = join(DIST_DIR, `stage-relaymind-${target}`)
  const payloadName = `relaymind-${target}`
  const payloadDir = join(stageDir, payloadName)

  await mkdir(payloadDir, { recursive: true })

  // Copy the viberelay binary, renamed to `relaymind` for basename routing.
  // Same source binary; bin.ts detects the invocation name and routes to the
  // RelayMind registrar when launched as `relaymind`.
  const binaryPath = join(binDir, 'viberelay')
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Binary not found: ${binaryPath}\n` +
      `Run: bun scripts/build.ts --target ${target} first.`
    )
  }
  await copyFile(binaryPath, join(payloadDir, 'relaymind'))
  await $`chmod +x ${join(payloadDir, 'relaymind')}`

  // macOS: re-sign after copy to avoid SIGKILL from Gatekeeper on ad-hoc sigs
  if (target.startsWith('bun-darwin-') && process.platform === 'darwin') {
    const bin = join(payloadDir, 'relaymind')
    await $`codesign --remove-signature ${bin}`.nothrow()
    await $`codesign --force --sign - ${bin}`
  }

  // Copy README — use RELAYMIND.md if it exists, otherwise emit a placeholder
  const readmeSrc = join(REPO_ROOT, 'RELAYMIND.md')
  const readmeDst = join(payloadDir, 'README.md')
  if (existsSync(readmeSrc)) {
    await copyFile(readmeSrc, readmeDst)
  } else {
    await Bun.write(
      readmeDst,
      `# relaymind\n\nDocumentation is coming soon.\n\nFor usage run: relaymind --help\n`
    )
  }

  // Copy LICENSE from repo root
  const licenseSrc = join(REPO_ROOT, 'LICENSE')
  if (existsSync(licenseSrc)) {
    await copyFile(licenseSrc, join(payloadDir, 'LICENSE'))
  }

  // Bundle the plugin payloads alongside the binary so the runtime
  // resolver can find them without source-tree walks. The standalone
  // bun-compiled binary cannot reach the repo via import.meta.url
  // because that URL points into bun's virtual FS — shipping the
  // bundles next to the binary is the only reliable production path.
  //
  // Layout in the tarball:
  //   plugins/
  //     relaymind/          ← contents of relaymind-plugin-cc/
  //     vibemind-telegram/  ← contents of telegram-plugin-cc/
  //
  // Resolver in profile-installer.ts maps short→long names so dev
  // (long, source-tree) and production (short, next-to-binary) layouts
  // both work without conditionals at the call site.
  const pluginsRoot = join(payloadDir, 'plugins')
  await mkdir(pluginsRoot, { recursive: true })
  await copyPlugin(join(REPO_ROOT, 'relaymind-plugin-cc'), join(pluginsRoot, 'relaymind'))
  await copyPlugin(join(REPO_ROOT, 'telegram-plugin-cc'), join(pluginsRoot, 'vibemind-telegram'))

  // Create the archive
  await mkdir(ARCHIVE_DIR, { recursive: true })
  const archive = join(ARCHIVE_DIR, `${payloadName}.tar.gz`)
  await $`tar -czf ${archive} ${payloadName}`.cwd(stageDir)

  console.log(`✓ ${archive}`)
}

/**
 * Recursively copy `src` into `dest`, skipping things we never want to
 * ship: dependency trees, test fixtures, lockfiles, and any tooling
 * artefact prefixed with `.bun.` (bun's installer scratch files).
 */
async function copyPlugin(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) {
    throw new Error(`Plugin source not found: ${src}`)
  }
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (shouldSkipPluginEntry(entry.name)) continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyPlugin(from, to)
    } else if (entry.isFile()) {
      await copyFile(from, to)
      if (entry.name.endsWith('.sh')) {
        await chmod(to, 0o755)
      }
    }
  }
}

function shouldSkipPluginEntry(name: string): boolean {
  if (name === 'node_modules') return true
  if (name === 'test') return true
  if (name === 'bun.lock' || name === '.bun.lock') return true
  if (name.startsWith('.bun.')) return true
  return false
}

await main()
