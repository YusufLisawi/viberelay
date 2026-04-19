/**
 * Tests for Fix B: SHA-256 verification + GitHub URL validation in `viberelay update`.
 */
import { createHash } from 'node:crypto'
import { arch, platform } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { runUpdateCommand } from '../src/commands/update.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function platformTarget(): string {
  const os = platform()
  const a = arch()
  const archMap: Record<string, string> = { x64: 'x64', arm64: 'arm64' }
  const mapped = archMap[a] ?? 'x64'
  switch (os) {
    case 'darwin': return `bun-darwin-${mapped}`
    case 'linux':  return `bun-linux-${mapped}`
    case 'win32':  return `bun-windows-${mapped}`
    default:       return `bun-linux-${mapped}`
  }
}

function platformExt(): 'tar.gz' | 'zip' {
  return platform() === 'win32' ? 'zip' : 'tar.gz'
}

const TARGET_ID = platformTarget()
const EXT = platformExt()
const ASSET_NAME = `viberelay-${TARGET_ID}.${EXT}`
const CHECKSUM_ASSET_NAME = `${ASSET_NAME}.sha256`

// Fake archive content — just bytes we control so we can compute the expected hash.
const FAKE_ARCHIVE_BYTES = Buffer.from('fake-archive-content-for-testing-0123456789')
const FAKE_CHECKSUM = createHash('sha256').update(FAKE_ARCHIVE_BYTES).digest('hex')

function mockRelease(
  tag: string,
  includeChecksumAsset: boolean,
  assetUrlOverride?: string
): { tag_name: string; html_url: string; assets: Array<{ name: string; browser_download_url: string }> } {
  const assetUrl = assetUrlOverride ?? `https://github.com/example/releases/download/${tag}/${ASSET_NAME}`
  const assets: Array<{ name: string; browser_download_url: string }> = [
    { name: ASSET_NAME, browser_download_url: assetUrl },
  ]
  if (includeChecksumAsset) {
    assets.push({
      name: CHECKSUM_ASSET_NAME,
      browser_download_url: `https://github.com/example/releases/download/${tag}/${CHECKSUM_ASSET_NAME}`,
    })
  }
  return { tag_name: tag, html_url: `https://github.com/example/releases/${tag}`, assets }
}

/**
 * Build a fetchImpl that serves:
 *  - The release JSON for the GitHub API endpoint
 *  - The fake archive bytes for the asset download
 *  - An optional custom checksum text for the .sha256 download
 */
function buildFetch(opts: {
  tag: string
  includeChecksumAsset: boolean
  checksumText?: string   // defaults to FAKE_CHECKSUM
  assetUrlOverride?: string
}): typeof fetch {
  const {
    tag,
    includeChecksumAsset,
    checksumText = FAKE_CHECKSUM,
    assetUrlOverride,
  } = opts

  const release = mockRelease(tag, includeChecksumAsset, assetUrlOverride)

  return async (url: string | URL | Request): Promise<Response> => {
    const urlStr = url.toString()
    if (urlStr.includes('api.github.com')) {
      return new Response(JSON.stringify(release), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (urlStr.endsWith(CHECKSUM_ASSET_NAME)) {
      if (!includeChecksumAsset) return new Response('not found', { status: 404 })
      return new Response(checksumText, { status: 200 })
    }
    if (urlStr.endsWith(ASSET_NAME)) {
      // Return fake binary bytes — the extract step is not reached in these tests
      // because we stub it out below via the extract path throwing first, but the
      // downloader needs something to hash.
      return new Response(FAKE_ARCHIVE_BYTES, { status: 200 })
    }
    return new Response('unexpected url: ' + urlStr, { status: 404 })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('update command — checksum verification (Fix B)', () => {
  it('valid checksum: proceeds past the checksum gate (extract step reached)', async () => {
    const fetchImpl = buildFetch({ tag: 'viberelay-v99.0.0', includeChecksumAsset: true })

    // We don't want to actually run tar/unzip in unit tests, so we expect the
    // command to fail at the extraction step — NOT at checksum verification.
    await expect(
      runUpdateCommand({ fetchImpl, currentVersion: '0.1.0', force: true })
    ).rejects.toThrow(/tar exited|unzip exited|extract|ENOENT/i)
    // Key assertion: error is NOT a checksum error.
  })

  it('mismatched checksum: throws with a "checksum mismatch" error', async () => {
    const wrongChecksum = 'a'.repeat(64) // 64 hex chars, wrong digest
    const fetchImpl = buildFetch({
      tag: 'viberelay-v99.0.0',
      includeChecksumAsset: true,
      checksumText: wrongChecksum,
    })

    await expect(
      runUpdateCommand({ fetchImpl, currentVersion: '0.1.0', force: true })
    ).rejects.toThrow(/checksum mismatch/i)
  })

  it('missing checksum asset in non-strict mode: warns and continues to extraction', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = buildFetch({ tag: 'viberelay-v99.0.0', includeChecksumAsset: false })

    // Should not throw a checksum error — it should reach the extract step instead.
    await expect(
      runUpdateCommand({ fetchImpl, currentVersion: '0.1.0', force: true })
    ).rejects.toThrow(/tar exited|unzip exited|extract|ENOENT/i)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/no checksum|skipping verification/i))
    warnSpy.mockRestore()
  })

  it('missing checksum asset in strict mode: throws a hard error', async () => {
    const fetchImpl = buildFetch({ tag: 'viberelay-v99.0.0', includeChecksumAsset: false })

    await expect(
      runUpdateCommand({ fetchImpl, currentVersion: '0.1.0', force: true, strict: true })
    ).rejects.toThrow(/no checksum asset found.*strict/i)
  })

  it('rejects asset URL pointing to non-GitHub host', async () => {
    const fetchImpl = buildFetch({
      tag: 'viberelay-v99.0.0',
      includeChecksumAsset: false,
      assetUrlOverride: 'https://evil.example.com/malware.tar.gz',
    })

    await expect(
      runUpdateCommand({ fetchImpl, currentVersion: '0.1.0', force: true })
    ).rejects.toThrow(/refusing to fetch asset from non-GitHub host/i)
  })

  it('accepts asset URL on objects.githubusercontent.com (GitHub CDN subdomain)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = buildFetch({
      tag: 'viberelay-v99.0.0',
      includeChecksumAsset: false,
      // This is the real CDN GitHub uses for release asset downloads
      assetUrlOverride: `https://objects.githubusercontent.com/releases/${ASSET_NAME}`,
    })

    // Should pass the URL check and proceed to extract (which will fail).
    await expect(
      runUpdateCommand({ fetchImpl, currentVersion: '0.1.0', force: true })
    ).rejects.toThrow(/tar exited|unzip exited|extract|ENOENT/i)

    warnSpy.mockRestore()
  })
})
