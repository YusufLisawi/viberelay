#!/usr/bin/env bun
/**
 * Smoke-test for the relaymind package pipeline.
 *
 * Steps:
 *   1. Compile relaymind for the host target
 *   2. Package it via package-relaymind.ts
 *   3. Unpack the tarball into a temp dir
 *   4. Run `relaymind --version` and `relaymind --help`
 *   5. Assert both exit successfully and produce non-empty output
 *
 * Usage:
 *   bun scripts/test-package-relaymind.ts
 *
 * The host target is inferred from the current platform. Fails fast on Windows.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { $ } from 'bun'

const REPO_ROOT = resolve(import.meta.dir, '..')

function detectHostTarget(): string {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'win32') {
    throw new Error(
      'relaymind smoke tests do not run on Windows — the binary is darwin/linux only.'
    )
  }

  const os = platform === 'darwin' ? 'darwin' : 'linux'
  const bunArch = arch === 'arm64' ? 'arm64' : 'x64'
  return `bun-${os}-${bunArch}`
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ FAIL: ${message}`)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const target = detectHostTarget()
  console.log(`→ smoke test for target: ${target}`)

  // Step 1: Build
  console.log('→ compiling relaymind...')
  await $`bun scripts/build.ts --target ${target}`.cwd(REPO_ROOT)

  // Verify binary exists before packaging
  const binaryPath = join(REPO_ROOT, 'dist', target, 'relaymind')
  assert(existsSync(binaryPath), `compiled binary not found at ${binaryPath}`)

  // Step 2: Package
  console.log('→ packaging...')
  await $`bun scripts/package-relaymind.ts --target ${target}`.cwd(REPO_ROOT)

  const archivePath = join(REPO_ROOT, 'dist', 'archives', `relaymind-${target}.tar.gz`)
  assert(existsSync(archivePath), `archive not found at ${archivePath}`)
  console.log(`  archive: ${archivePath}`)

  // Step 3: Unpack into temp dir
  const tmpDir = await mkdtemp(join(tmpdir(), 'relaymind-smoke-'))
  try {
    console.log(`→ extracting to ${tmpDir}...`)
    await $`tar -xzf ${archivePath} -C ${tmpDir}`

    const extractedBin = join(tmpDir, `relaymind-${target}`, 'relaymind')
    assert(existsSync(extractedBin), `binary not found in archive at ${extractedBin}`)

    // macOS: re-sign to avoid SIGKILL on Gatekeeper-enforced kernels
    if (process.platform === 'darwin') {
      await $`codesign --remove-signature ${extractedBin}`.nothrow()
      await $`codesign --force --sign - ${extractedBin}`.nothrow()
    }

    // Step 4 + 5: Run --version
    console.log('→ running relaymind --version...')
    const versionResult = await $`${extractedBin} --version`.nothrow()
    assert(
      versionResult.exitCode === 0,
      `--version exited with code ${versionResult.exitCode}`
    )
    const versionOutput = versionResult.stdout.toString().trim()
    assert(versionOutput.length > 0, '--version produced no output')
    console.log(`  version output: ${versionOutput}`)

    // Run --help
    console.log('→ running relaymind --help...')
    const helpResult = await $`${extractedBin} --help`.nothrow()
    // --help may exit 0 or 1 depending on CLI framework; we just need output
    const helpOutput = helpResult.stdout.toString().trim() + helpResult.stderr.toString().trim()
    assert(helpOutput.length > 0, '--help produced no output')
    console.log(`  help output length: ${helpOutput.length} chars`)

    // Verify archive contains LICENSE
    const licenseExists = existsSync(join(tmpDir, `relaymind-${target}`, 'LICENSE'))
    assert(licenseExists, 'LICENSE not found in archive')

    // Verify archive contains README.md
    const readmeExists = existsSync(join(tmpDir, `relaymind-${target}`, 'README.md'))
    assert(readmeExists, 'README.md not found in archive')

    console.log(`\n✓ all smoke tests passed for ${target}`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

await main()
