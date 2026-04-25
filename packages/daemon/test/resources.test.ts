import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundledBinaryPath, bundledConfigPath } from '../src/index.js'

describe('bundled resources', () => {
  it('uses viberelay-local bundled CLIProxyAPI binary and config', async () => {
    const expectedResourcesDir = join(process.cwd(), 'resources')

    expect(dirname(bundledBinaryPath)).toBe(expectedResourcesDir)
    expect(dirname(bundledConfigPath)).toBe(expectedResourcesDir)
    expect(basename(bundledBinaryPath)).toBe(process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api')
    expect(basename(bundledConfigPath)).toBe('config.yaml')

    await expect(access(bundledBinaryPath, fsConstants.F_OK | fsConstants.X_OK)).resolves.toBeUndefined()
    await expect(access(bundledConfigPath, fsConstants.F_OK | fsConstants.R_OK)).resolves.toBeUndefined()
  })
})
