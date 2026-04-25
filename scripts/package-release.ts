#!/usr/bin/env bun
/**
 * Package a built target into a distributable archive alongside runtime
 * resources (cli-proxy-api child + config + static dashboard assets).
 *
 *   bun run scripts/package-release.ts --target bun-darwin-arm64
 *
 * Produces: ./dist/archives/viberelay-<target>.tar.gz (or .zip on windows)
 *
 * Caveat: the native `cli-proxy-api` child binary in resources/ must
 * match the target OS/arch. CI is expected to drop the right binary into
 * resources/ before invoking this script.
 */

import { mkdir, copyFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DIST_DIR = join(REPO_ROOT, 'dist')
const ARCHIVE_DIR = join(DIST_DIR, 'archives')

interface CliArgs { target: string }

function parseArgs(argv: string[]): CliArgs {
  const idx = argv.indexOf('--target')
  if (idx < 0 || !argv[idx + 1]) throw new Error('--target <bun-target> required')
  return { target: argv[idx + 1]! }
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

async function main(): Promise<void> {
  const { target } = parseArgs(process.argv)
  const isWindows = target.includes('windows')
  const ext = isWindows ? '.exe' : ''
  const binDir = join(DIST_DIR, target)
  const stageDir = join(DIST_DIR, `stage-${target}`)
  const payloadName = `viberelay-${target}`
  const payloadDir = join(stageDir, payloadName)

  await mkdir(join(payloadDir, 'bin'), { recursive: true })
  await copyFile(join(binDir, `viberelay${ext}`), join(payloadDir, 'bin', `viberelay${ext}`))
  await copyFile(join(binDir, `viberelay-daemon${ext}`), join(payloadDir, 'bin', `viberelay-daemon${ext}`))

  // macOS arm64/x64: Bun-compiled binaries have an ad-hoc signature that
  // survives local use but gets invalidated in transit (tar → network →
  // untar). Re-sign after copying so the user-facing archive launches
  // without SIGKILL on Gatekeeper-enforced kernels.
  if (target.startsWith('bun-darwin-') && process.platform === 'darwin') {
    for (const name of ['viberelay', 'viberelay-daemon']) {
      const bin = join(payloadDir, 'bin', name)
      await $`codesign --remove-signature ${bin}`.nothrow()
      await $`codesign --force --sign - ${bin}`
    }
  }
  await copyDir(join(REPO_ROOT, 'resources'), join(payloadDir, 'resources'))
  await copyFile(join(REPO_ROOT, 'packages', 'cli', 'README.md'), join(payloadDir, 'README.md'))

  await mkdir(ARCHIVE_DIR, { recursive: true })
  if (isWindows) {
    const archive = join(ARCHIVE_DIR, `${payloadName}.zip`)
    if (process.platform === 'win32') {
      await $`powershell -NoLogo -NoProfile -NonInteractive -Command ${`Compress-Archive -Path ${payloadName} -DestinationPath ${archive} -Force`}`.cwd(stageDir)
    } else {
      await $`zip -qr ${archive} ${payloadName}`.cwd(stageDir)
    }
    console.log(`✓ ${archive}`)
  } else {
    const archive = join(ARCHIVE_DIR, `${payloadName}.tar.gz`)
    await $`tar -czf ${archive} ${payloadName}`.cwd(stageDir)
    console.log(`✓ ${archive}`)
  }
}

await main()
