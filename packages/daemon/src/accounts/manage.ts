import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const devRepoRoot = resolve(currentDirectory, '../../../..')
// Mirror the pattern in packages/daemon/src/index.ts: when running as a Bun
// --compile binary, import.meta.url lives inside the read-only /$bunfs/
// virtual filesystem, so we anchor resources on process.execPath instead.
const isCompiled = import.meta.url.startsWith('file:///$bunfs/') || import.meta.url.includes('/$bunfs/root/')
const installRoot = isCompiled ? resolve(dirname(process.execPath), '..') : devRepoRoot
const bundledBinaryPath = resolve(installRoot, process.platform === 'win32' ? 'resources/cli-proxy-api-plus.exe' : 'resources/cli-proxy-api-plus')
const bundledConfigPath = resolve(installRoot, 'resources/config.yaml')

const MAX_OAUTH_STREAM_BYTES = 1 * 1024 * 1024

const activeOAuthChildren = new Map<string, ChildProcess>()

function killActiveOAuthChild(provider: string) {
  const existing = activeOAuthChildren.get(provider)
  if (!existing) return
  activeOAuthChildren.delete(provider)
  if (existing.exitCode !== null || existing.signalCode !== null) return
  try { existing.kill('SIGTERM') } catch {}
  setTimeout(() => {
    if (existing.exitCode === null && existing.signalCode === null) {
      try { existing.kill('SIGKILL') } catch {}
    }
  }, 500).unref()
}

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
  killActiveOAuthChild(provider)
  return new Promise<{ ok: boolean, message: string }>((resolvePromise) => {
    let resolved = false
    const timers: NodeJS.Timeout[] = []
    const clearTimers = () => {
      while (timers.length > 0) {
        const timer = timers.pop()
        if (timer) clearTimeout(timer)
      }
    }
    const finish = (result: { ok: boolean, message: string }) => {
      if (resolved) return
      resolved = true
      clearTimers()
      // Ensure the child process is not orphaned when we early-resolve.
      if (child.exitCode === null && child.signalCode === null) {
        const grace = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGTERM') } catch {}
          }
        }, 300_000)
        grace.unref()
        const hard = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL') } catch {}
          }
        }, 310_000)
        hard.unref()
      }
      resolvePromise(result)
    }

    const child = spawn(bundledBinaryPath, ['-config', bundledConfigPath, loginArg], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })
    activeOAuthChildren.set(provider, child)
    child.on('exit', () => {
      if (activeOAuthChildren.get(provider) === child) {
        activeOAuthChildren.delete(provider)
      }
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    const appendCapped = (current: string, chunk: string, truncated: boolean): { value: string, truncated: boolean } => {
      if (truncated) return { value: current, truncated: true }
      if (current.length + chunk.length <= MAX_OAUTH_STREAM_BYTES) {
        return { value: current + chunk, truncated: false }
      }
      const remaining = MAX_OAUTH_STREAM_BYTES - current.length
      return { value: current + (remaining > 0 ? chunk.slice(0, remaining) : ''), truncated: true }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendCapped(stdout, chunk.toString('utf8'), stdoutTruncated)
      stdout = next.value
      stdoutTruncated = next.truncated
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendCapped(stderr, chunk.toString('utf8'), stderrTruncated)
      stderr = next.value
      stderrTruncated = next.truncated
    })

    if (provider === 'codex') {
      const poke = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.stdin.write('\n') } catch {}
        }
      }, 5000)
      poke.unref()
      timers.push(poke)
    }

    const earlyFinish = setTimeout(() => {
      const combined = `${stdout}\n${stderr}`
      if (child.exitCode === null && child.signalCode === null) {
        if (combined.includes('Opening browser') || combined.includes('authorization') || combined.includes('device code')) {
          finish({ ok: true, message: 'Browser opened for authentication. Complete login there.' })
          return
        }
        finish({ ok: true, message: 'Authentication process started. Complete login in browser.' })
      }
    }, provider === 'github-copilot' ? 2000 : 1000)
    earlyFinish.unref()
    timers.push(earlyFinish)

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
