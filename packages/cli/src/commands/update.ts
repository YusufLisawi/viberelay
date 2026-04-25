import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform, arch, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { UPSTREAM_REPO, VERSION } from '../version.js'

export interface UpdateCommandOptions {
  repo?: string
  currentVersion?: string
  prefix?: string
  check?: boolean
  force?: boolean
  strict?: boolean
  channel?: 'stable' | 'nightly'
  fetchImpl?: typeof fetch
}

interface GitHubRelease {
  tag_name: string
  assets: Array<{ name: string, browser_download_url: string }>
  html_url: string
  body?: string
}

/**
 * Validate that a download URL is hosted on github.com or a github.com subdomain.
 * This prevents a tampered GitHub API response from redirecting the download
 * (and any bearer token) to an attacker-controlled host.
 */
function assertGitHubUrl(url: string): void {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new Error(`invalid asset URL: ${url}`)
  }
  const isGitHub =
    hostname === 'github.com' ||
    hostname.endsWith('.github.com') ||
    hostname.endsWith('.githubusercontent.com')
  if (!isGitHub) {
    throw new Error(`refusing to fetch asset from non-GitHub host: ${hostname}`)
  }
}

export async function runUpdateCommand(options: UpdateCommandOptions = {}): Promise<string> {
  const repo = options.repo ?? process.env.VIBERELAY_REPO ?? UPSTREAM_REPO
  const currentVersion = options.currentVersion ?? VERSION
  const prefix = options.prefix ?? defaultPrefix()
  const doFetch = options.fetchImpl ?? fetch
  const channel = options.channel ?? 'stable'
  const strict = options.strict ?? false

  const release = await fetchRelease(repo, channel, doFetch)
  const latest = normalizeTag(release.tag_name)
  const current = normalizeTag(currentVersion)

  if (!options.force && latest === current) {
    return `viberelay ${currentVersion} is up to date (${release.html_url})`
  }
  if (options.check) {
    return `update available: ${current} → ${latest} (${release.html_url})`
  }

  const target = detectTarget()
  const assetName = `viberelay-${target.id}.${target.ext}`
  const asset = release.assets.find((entry) => entry.name === assetName)
  if (!asset) {
    throw new Error(`release ${release.tag_name} has no asset ${assetName}. Available: ${release.assets.map((a) => a.name).join(', ')}`)
  }

  // Validate that the download URL is on github.com before we touch it.
  assertGitHubUrl(asset.browser_download_url)

  // Look for the companion checksum asset.
  const checksumAssetName = `${assetName}.sha256`
  const checksumAsset = release.assets.find((entry) => entry.name === checksumAssetName)

  const tmpDir = join(tmpdir(), `viberelay-update-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })
  try {
    const archivePath = join(tmpDir, assetName)
    await downloadTo(asset.browser_download_url, archivePath, doFetch)

    if (checksumAsset) {
      assertGitHubUrl(checksumAsset.browser_download_url)
      const checksumPath = join(tmpDir, checksumAssetName)
      await downloadTo(checksumAsset.browser_download_url, checksumPath, doFetch)
      await verifyChecksum(archivePath, checksumPath)
    } else if (strict) {
      throw new Error(`no checksum asset found for ${assetName} and --strict is enabled`)
    } else {
      console.warn(`⚠ no checksum asset found for ${assetName}; skipping verification`)
    }

    const payloadDir = await extract(archivePath, tmpDir, target.ext)
    await swapPrefix(payloadDir, prefix, target.windows)
    await writeFile(join(prefix, 'VERSION'), `${latest}\n`)
    return `upgraded ${current} → ${latest}${target.windows ? ' (restart any running viberelay processes)' : ''}`
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

function defaultPrefix(): string {
  return process.env.VIBERELAY_PREFIX ?? join(homedir(), '.viberelay')
}

function normalizeTag(tag: string): string {
  const stripped = tag.startsWith('viberelay-v') ? tag.slice('viberelay-v'.length) : tag
  return stripped.startsWith('v') ? stripped.slice(1) : stripped
}

function detectTarget(): { id: string, ext: 'tar.gz' | 'zip', windows: boolean } {
  const os = platform()
  const archKey = arch()
  const archMap: Record<string, 'x64' | 'arm64'> = { x64: 'x64', arm64: 'arm64' }
  const mapped = archMap[archKey]
  if (!mapped) throw new Error(`unsupported arch: ${archKey}`)
  switch (os) {
    case 'darwin': return { id: `bun-darwin-${mapped}`, ext: 'tar.gz', windows: false }
    case 'linux':  return { id: `bun-linux-${mapped}`, ext: 'tar.gz', windows: false }
    case 'win32':  return { id: `bun-windows-${mapped}`, ext: 'zip', windows: true }
    default: throw new Error(`unsupported OS: ${os}`)
  }
}

async function fetchRelease(repo: string, channel: 'stable' | 'nightly', doFetch: typeof fetch): Promise<GitHubRelease> {
  const path = channel === 'nightly' ? 'releases/tags/viberelay-nightly' : 'releases/latest'
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.VIBERELAY_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  const response = await doFetch(`https://api.github.com/repos/${repo}/${path}`, { headers })
  if (!response.ok) throw new Error(`GitHub API error ${response.status} for ${repo}/${path}. Private repo? Set VIBERELAY_TOKEN or GITHUB_TOKEN.`)
  return await response.json() as GitHubRelease
}

async function downloadTo(url: string, destination: string, doFetch: typeof fetch): Promise<void> {
  const headers: Record<string, string> = {}
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.VIBERELAY_TOKEN
  if (token && url.includes('api.github.com')) {
    headers.authorization = `Bearer ${token}`
    headers.accept = 'application/octet-stream'
  }
  const response = await doFetch(url, { headers })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

/**
 * Compute the SHA-256 of `filePath` and compare it against the expected hash
 * found in `checksumFilePath`. The checksum file format is either:
 *   <hex>  <filename>
 * or just a bare hex digest (one per line).
 */
async function verifyChecksum(filePath: string, checksumFilePath: string): Promise<void> {
  const [fileBytes, checksumRaw] = await Promise.all([
    readFile(filePath),
    readFile(checksumFilePath, 'utf8')
  ])
  const actual = createHash('sha256').update(fileBytes).digest('hex')
  // The checksum file may contain "<hash>  <filename>" or just "<hash>".
  const expected = checksumRaw.trim().split(/\s+/)[0]?.toLowerCase()
  if (!expected) throw new Error('checksum file is empty or malformed')
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${filePath}: expected ${expected}, got ${actual}`)
  }
}

async function extract(archive: string, into: string, ext: 'tar.gz' | 'zip'): Promise<string> {
  const { spawn } = await import('node:child_process')
  await new Promise<void>((resolvePromise, reject) => {
    const args = ext === 'tar.gz'
      ? ['tar', ['-xzf', archive, '-C', into]] as const
      : ['unzip', ['-q', archive, '-d', into]] as const
    const [cmd, cmdArgs] = args
    const child = spawn(cmd, [...cmdArgs], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${cmd} exited ${code}`)))
  })
  const entries = await readdir(into)
  const payload = entries.find((name) => name.startsWith('viberelay-bun-'))
  if (!payload) throw new Error(`extracted archive missing payload directory in ${into}`)
  return join(into, payload)
}

async function swapPrefix(payloadDir: string, prefix: string, windows: boolean): Promise<void> {
  await mkdir(prefix, { recursive: true })
  const currentExe = process.execPath
  const runningInsidePrefix = resolve(currentExe).startsWith(resolve(prefix))

  // Replace subdirectories atomically.
  for (const entry of await readdir(payloadDir)) {
    const src = join(payloadDir, entry)
    const dst = join(prefix, entry)
    if (windows && runningInsidePrefix && entry === 'bin') {
      await replaceBinDirWindows(src, dst)
      continue
    }
    await rm(dst, { recursive: true, force: true })
    await rename(src, dst)
  }

  await ensureExec(prefix)
}

async function replaceBinDirWindows(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true })
  for (const entry of await readdir(src)) {
    const target = join(dst, entry)
    const incoming = join(src, entry)
    try {
      await rename(target, `${target}.old-${Date.now()}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(incoming, target)
  }
}

async function ensureExec(prefix: string): Promise<void> {
  if (platform() === 'win32') return
  const bin = join(prefix, 'bin')
  for (const entry of await readdir(bin).catch(() => [])) {
    await chmod(join(bin, entry), 0o755).catch(() => undefined)
  }
  const child = join(prefix, 'resources', 'cli-proxy-api')
  try {
    await stat(child)
    await chmod(child, 0o755)
  } catch {
    /* optional */
  }
}
