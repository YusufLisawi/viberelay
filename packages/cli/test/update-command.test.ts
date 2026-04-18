import { describe, expect, it } from 'vitest'
import { runUpdateCommand } from '../src/commands/update.js'
import { VERSION } from '../src/version.js'

function mockRelease(tag: string): Response {
  return new Response(JSON.stringify({
    tag_name: tag,
    html_url: `https://github.com/example/releases/${tag}`,
    assets: []
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('update command', () => {
  it('reports up-to-date when installed matches latest release', async () => {
    const fetchImpl: typeof fetch = async () => mockRelease(`viberelay-v${VERSION}`)
    const result = await runUpdateCommand({ fetchImpl })
    expect(result).toContain('up to date')
  })

  it('advertises newer version in --check mode', async () => {
    const fetchImpl: typeof fetch = async () => mockRelease('viberelay-v99.0.0')
    const result = await runUpdateCommand({ fetchImpl, check: true, currentVersion: '0.1.0' })
    expect(result).toContain('update available: 0.1.0 → 99.0.0')
  })

  it('throws when release has no matching asset for this platform', async () => {
    const fetchImpl: typeof fetch = async () => mockRelease('viberelay-v99.0.0')
    await expect(runUpdateCommand({ fetchImpl, currentVersion: '0.1.0' }))
      .rejects.toThrow(/has no asset viberelay-bun-/)
  })
})
