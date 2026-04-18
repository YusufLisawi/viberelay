import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('cli bin wiring', () => {
  it('declares viberelay bin entry', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> }
    expect(pkg.bin.viberelay).toBe('./src/bin.ts')
  })
})
