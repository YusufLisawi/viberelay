#!/usr/bin/env bun
/**
 * Download the upstream `cli-proxy-api-plus` Go binary for a given target
 * and drop it into ./resources/ so packaging can ship it.
 *
 *   bun scripts/fetch-cliproxy.ts --target bun-darwin-arm64
 *   bun scripts/fetch-cliproxy.ts --target bun-linux-x64 --version v6.9.28-0
 *
 * Version defaults to `latest`. The resolved tag is written to
 * resources/CLIPROXY_VERSION for later use by `viberelay update`.
 *
 * Source: https://github.com/router-for-me/CLIProxyAPIPlus/releases
 */

import { mkdir, rm, writeFile, rename, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

const REPO_ROOT = resolve(import.meta.dir, '..')
const RESOURCES = join(REPO_ROOT, 'resources')
const UPSTREAM_REPO = 'router-for-me/CLIProxyAPIPlus'

const TARGET_MAP: Record<string, { goos: string, goarch: string, ext: 'tar.gz' | 'zip', binaryName: string }> = {
  'bun-darwin-x64':   { goos: 'darwin',  goarch: 'amd64', ext: 'tar.gz', binaryName: 'cli-proxy-api-plus' },
  'bun-darwin-arm64': { goos: 'darwin',  goarch: 'arm64', ext: 'tar.gz', binaryName: 'cli-proxy-api-plus' },
  'bun-linux-x64':    { goos: 'linux',   goarch: 'amd64', ext: 'tar.gz', binaryName: 'cli-proxy-api-plus' },
  'bun-linux-arm64':  { goos: 'linux',   goarch: 'arm64', ext: 'tar.gz', binaryName: 'cli-proxy-api-plus' },
  'bun-windows-x64':  { goos: 'windows', goarch: 'amd64', ext: 'zip',    binaryName: 'cli-proxy-api-plus.exe' }
}

interface Args { target: string, version: string }

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  const target = valueAfter(args, '--target')
  if (!target) throw new Error('--target required')
  if (!(target in TARGET_MAP)) throw new Error(`unknown target ${target}`)
  return { target, version: valueAfter(args, '--version') ?? 'latest' }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

async function resolveTag(version: string): Promise<string> {
  if (version !== 'latest') return version
  const response = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' }
  })
  if (!response.ok) throw new Error(`failed to resolve latest upstream tag: ${response.status}`)
  const data = await response.json() as { tag_name: string }
  return data.tag_name
}

function assetName(tag: string, map: typeof TARGET_MAP[string]): string {
  const bare = tag.startsWith('v') ? tag.slice(1) : tag
  return `CLIProxyAPIPlus_${bare}_${map.goos}_${map.goarch}.${map.ext}`
}

async function main(): Promise<void> {
  const { target, version } = parseArgs(process.argv)
  const map = TARGET_MAP[target]!
  const tag = await resolveTag(version)
  const asset = assetName(tag, map)
  const url = `https://github.com/${UPSTREAM_REPO}/releases/download/${tag}/${asset}`

  const tmp = join(REPO_ROOT, '.tmp-cliproxy')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })

  console.log(`→ fetching ${url}`)
  const localArchive = join(tmp, asset)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`)
  await writeFile(localArchive, Buffer.from(await response.arrayBuffer()))

  console.log('→ extracting')
  if (map.ext === 'tar.gz') {
    await $`tar -xzf ${localArchive} -C ${tmp}`.cwd(REPO_ROOT)
  } else {
    await $`unzip -q ${localArchive} -d ${tmp}`.cwd(REPO_ROOT)
  }

  const extracted = join(tmp, map.binaryName)
  const destination = join(RESOURCES, map.binaryName)
  await mkdir(RESOURCES, { recursive: true })
  await rename(extracted, destination)
  if (!target.includes('windows')) {
    await chmod(destination, 0o755)
  }
  await writeFile(join(RESOURCES, 'CLIPROXY_VERSION'), `${tag}\n`)
  await rm(tmp, { recursive: true, force: true })

  console.log(`✓ ${map.binaryName} (${tag}) → ${destination}`)
}

await main()
