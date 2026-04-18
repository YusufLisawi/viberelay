import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDirectory, '../../../..')
const bundledBinaryPath = resolve(repoRoot, 'resources/cli-proxy-api-plus')
const bundledConfigPath = resolve(repoRoot, 'resources/config.yaml')

export async function saveApiKeyAccount(authDir: string, provider: 'opencode' | 'nvidia' | 'ollama' | 'openrouter', apiKey: string) {
  await mkdir(authDir, { recursive: true })
  const keyPreview = apiKey.slice(0, 8) + '...' + apiKey.slice(-4)
  const fileName = `${provider}-${randomUUID().slice(0, 8)}.json`
  const filePath = join(authDir, fileName)
  const payload = {
    type: provider,
    email: keyPreview,
    api_key: apiKey,
    created: new Date().toISOString()
  }
  await writeFile(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 })
  return { fileName }
}

export async function launchOAuthLogin(provider: 'claude' | 'codex' | 'github-copilot') {
  const argsByProvider: Record<string, string> = {
    claude: '-claude-login',
    codex: '-codex-login',
    'github-copilot': '-github-copilot-login'
  }
  const loginArg = argsByProvider[provider]
  return new Promise<{ ok: boolean, message: string }>((resolvePromise) => {
    let resolved = false
    const finish = (result: { ok: boolean, message: string }) => {
      if (resolved) return
      resolved = true
      resolvePromise(result)
    }

    const child = spawn(bundledBinaryPath, ['-config', bundledConfigPath, loginArg], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    if (provider === 'codex') {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.stdin.write('\n') } catch {}
        }
      }, 5000).unref()
    }

    setTimeout(() => {
      const combined = `${stdout}\n${stderr}`
      if (child.exitCode === null && child.signalCode === null) {
        if (combined.includes('Opening browser') || combined.includes('authorization') || combined.includes('device code')) {
          finish({ ok: true, message: 'Browser opened for authentication. Complete login there.' })
          return
        }
        finish({ ok: true, message: 'Authentication process started. Complete login in browser.' })
      }
    }, provider === 'github-copilot' ? 2000 : 1000).unref()

    child.on('close', (code) => {
      const combined = `${stderr}\n${stdout}`.trim()
      if (combined.includes('Opening browser') || combined.includes('authorization') || code === 0) {
        finish({ ok: true, message: 'Browser opened for authentication. Complete login in browser.' })
        return
      }
      finish({ ok: false, message: combined || `Authentication failed (exit ${code ?? -1})` })
    })
    child.on('error', (error) => finish({ ok: false, message: error.message }))
  })
}
