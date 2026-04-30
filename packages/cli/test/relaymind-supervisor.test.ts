import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { relayMindPaths, type SupervisorSessionMeta } from '@viberelay/shared/relaymind'
import {
  attachSession,
  buildClaudeArgs,
  capturePane,
  getStatus,
  rollbackRegistry,
  runHealthCheck,
  sendKeys,
  snapshotRegistry,
  startSession,
  stopSession,
  tailLogs,
  tmuxAvailable,
  type TmuxFn,
  type TmuxResult,
} from '../src/lib/supervisor.js'

// Channel selectors / skip-permissions flag the supervisor MUST pass to
// Claude Code 2.x — kept as constants so the assertions read like a spec.
const CHANNEL_TELEGRAM = 'plugin:vibemind-telegram@vibemind-local'
const CHANNEL_RELAYMIND = 'plugin:vibemind-relaymind@vibemind-local'
const SKIP_PERMS = '--dangerously-skip-permissions'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'relaymind-supervisor-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

// ─── Tmux fake ──────────────────────────────────────────────────────────────

interface TmuxCall {
  args: readonly string[]
}

interface TmuxFakeOpts {
  /** Sessions that should be reported as running (has-session => 0). */
  initiallyRunning?: ReadonlySet<string>
  /** Pane pid to return for list-panes. */
  panePid?: number
  /** Override -V exit code (default 0 — tmux is available). */
  versionExitCode?: number
  /** Force new-session to fail with this exit + stderr. */
  newSessionError?: { exitCode: number; stderr: string }
}

function makeTmuxFake(opts: TmuxFakeOpts = {}): {
  fn: TmuxFn
  calls: TmuxCall[]
  running: Set<string>
} {
  const calls: TmuxCall[] = []
  const running = new Set<string>(opts.initiallyRunning ?? [])
  const fn: TmuxFn = async (args) => {
    calls.push({ args: [...args] })
    const verb = args[0]
    if (verb === '-V') {
      return mkResult(opts.versionExitCode ?? 0, 'tmux 3.4\n', '')
    }
    if (verb === 'has-session') {
      const name = args[args.indexOf('-t') + 1]
      return running.has(name)
        ? mkResult(0, '', '')
        : mkResult(1, '', `can't find session: ${name}`)
    }
    if (verb === 'new-session') {
      if (opts.newSessionError) {
        return mkResult(opts.newSessionError.exitCode, '', opts.newSessionError.stderr)
      }
      const name = args[args.indexOf('-s') + 1]
      running.add(name)
      return mkResult(0, '', '')
    }
    if (verb === 'list-panes') {
      return mkResult(0, `${opts.panePid ?? 12345}\n`, '')
    }
    if (verb === 'kill-session') {
      const name = args[args.indexOf('-t') + 1]
      const had = running.delete(name)
      return had ? mkResult(0, '', '') : mkResult(1, '', 'no session')
    }
    if (verb === 'send-keys') {
      return mkResult(0, '', '')
    }
    if (verb === 'capture-pane') {
      return mkResult(0, 'line1\nline2\n', '')
    }
    return mkResult(1, '', `unhandled verb ${verb ?? '<none>'}`)
  }
  return { fn, calls, running }
}

function mkResult(exitCode: number, stdout: string, stderr: string): TmuxResult {
  return { exitCode, stdout, stderr }
}

const callArgs = (calls: TmuxCall[]): string[][] => calls.map((c) => [...c.args])

// ─── tmuxAvailable ──────────────────────────────────────────────────────────

describe('supervisor.tmuxAvailable', () => {
  it('returns true when tmux -V succeeds', async () => {
    const tmux = makeTmuxFake()
    expect(await tmuxAvailable({ tmuxFn: tmux.fn })).toBe(true)
  })

  it('returns false when tmux -V fails', async () => {
    const tmux = makeTmuxFake({ versionExitCode: 127 })
    expect(await tmuxAvailable({ tmuxFn: tmux.fn })).toBe(false)
  })
})

// ─── startSession ───────────────────────────────────────────────────────────

describe('supervisor.startSession', () => {
  it('invokes tmux new-session with cwd, env, and claude args, persisting pid+meta atomically', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.claudeHome, { recursive: true })
    const tmux = makeTmuxFake({ panePid: 54321 })

    const meta = await startSession(paths, {
      sessionName: 'relaymind-main',
      claudeBin: 'claude',
      tmuxFn: tmux.fn,
    })

    expect(meta.pid).toBe(54321)
    expect(meta.sessionName).toBe('relaymind-main')
    expect(meta.status).toBe('starting')

    const all = callArgs(tmux.calls)
    // Order: -V (probe), has-session (collision check), new-session, list-panes
    expect(all[0]).toEqual(['-V'])
    expect(all[1]).toEqual(['has-session', '-t', 'relaymind-main'])
    // The supervisor injects TELEGRAM_STATE_DIR (and TELEGRAM_BOT_TOKEN
    // when present in the parent env) so the plugin's pairing/allowlist
    // state stays profile-isolated. Order of -e flags is dict-insertion;
    // we assert by membership rather than positional equality so test
    // stays stable across env-key reorderings.
    const newSessionArgs = all[2]!
    expect(newSessionArgs[0]).toBe('new-session')
    expect(newSessionArgs).toContain('-s')
    expect(newSessionArgs).toContain('relaymind-main')
    expect(newSessionArgs).toContain(`CLAUDE_PROJECT_DIR=${paths.claudeHome}`)
    expect(newSessionArgs).toContain('VIBERELAY_RELAYMIND_PROFILE=1')
    expect(newSessionArgs).toContain(`TELEGRAM_STATE_DIR=${paths.telegramStateDir}`)
    // After the `--` separator: claude + flags
    const dashDash = newSessionArgs.indexOf('--')
    expect(newSessionArgs.slice(dashDash + 1)).toEqual([
      'claude',
      '--name',
      'relaymind-main',
      '--channels',
      CHANNEL_TELEGRAM,
      SKIP_PERMS,
    ])
    expect(all[3]).toEqual(['list-panes', '-t', 'relaymind-main', '-F', '#{pane_pid}'])

    const pid = (await readFile(paths.pidFile, 'utf8')).trim()
    expect(pid).toBe('54321')
    const onDisk = JSON.parse(await readFile(paths.sessionFile, 'utf8')) as SupervisorSessionMeta
    expect(onDisk).toMatchObject({ pid: 54321, sessionName: 'relaymind-main', status: 'starting' })

    // No partial-write artifacts left behind.
    await expect(stat(`${paths.pidFile}.tmp`)).rejects.toThrow()
    await expect(stat(`${paths.sessionFile}.tmp`)).rejects.toThrow()
  })

  it('passes --resume and the previous claude session id when resume=true', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.supervisorStateDir, { recursive: true })
    const previous: SupervisorSessionMeta = {
      sessionName: 'relaymind-main',
      claudeSessionId: 'sess-abc-123',
      pid: 1,
      startedAt: '2026-04-26T00:00:00.000Z',
      status: 'stopped',
    }
    await writeFile(paths.sessionFile, JSON.stringify(previous), 'utf8')
    const tmux = makeTmuxFake({ panePid: 99 })

    await startSession(paths, { resume: true, tmuxFn: tmux.fn })

    const newSessionCall = tmux.calls.find((c) => c.args[0] === 'new-session')
    expect(newSessionCall).toBeDefined()
    const args = newSessionCall!.args
    // The claude args come after `--`.
    const dashDash = args.indexOf('--')
    expect(args.slice(dashDash + 1)).toEqual([
      'claude',
      '--name',
      'relaymind-main',
      '--resume',
      'sess-abc-123',
      '--channels',
      CHANNEL_TELEGRAM,
      SKIP_PERMS,
    ])
  })

  it('throws when tmux is unavailable', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake({ versionExitCode: 127 })
    await expect(startSession(paths, { tmuxFn: tmux.fn })).rejects.toThrow(/tmux not found/)
  })

  it('refuses to double-start when a tmux session already exists for that name', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake({ initiallyRunning: new Set(['relaymind-main']) })
    await expect(
      startSession(paths, { sessionName: 'relaymind-main', tmuxFn: tmux.fn }),
    ).rejects.toThrow(/already running/)
  })

  it('surfaces tmux new-session failures', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake({
      newSessionError: { exitCode: 1, stderr: 'something went wrong' },
    })
    await expect(startSession(paths, { tmuxFn: tmux.fn })).rejects.toThrow(/new-session failed/)
  })
})

// ─── viberelay-driven runner / bare-claude fallback ────────────────────────

describe('supervisor.startSession runner resolution', () => {
  it('builds viberelay run <profile> -- --name <session> when a profile is configured and exists', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.claudeHome, { recursive: true })
    await mkdir(paths.stateRoot, { recursive: true })
    // Persist a viberelay profile binding in config.json.
    await writeFile(
      paths.configJson,
      JSON.stringify({ sessionName: 'relaymind-main', viberelayProfile: { name: 'relaymind' } }),
      'utf8',
    )
    const tmux = makeTmuxFake({ panePid: 7777 })

    await startSession(paths, {
      sessionName: 'relaymind-main',
      tmuxFn: tmux.fn,
      // Stub the profile-existence probe so the test doesn't depend on
      // the real ~/.viberelay/profiles/relaymind.json.
      profileExists: async () => true,
    })

    const newSession = tmux.calls.find((c) => c.args[0] === 'new-session')!
    const args = [...newSession.args]
    const dashDash = args.indexOf('--')
    expect(args.slice(dashDash + 1)).toEqual([
      'viberelay',
      'run',
      '-d',
      'relaymind',
      '--name',
      'relaymind-main',
      '--channels',
      CHANNEL_TELEGRAM,
    ])

    const log = await readFile(join(paths.supervisorStateDir, 'supervisor.log'), 'utf8')
    expect(log).toContain('runner=profile=relaymind')
  })

  it('falls back to bare claude with a warning when the configured profile does not exist on disk', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.claudeHome, { recursive: true })
    await mkdir(paths.stateRoot, { recursive: true })
    await writeFile(
      paths.configJson,
      JSON.stringify({ sessionName: 'relaymind-main', viberelayProfile: { name: 'missing-profile' } }),
      'utf8',
    )
    const tmux = makeTmuxFake({ panePid: 8888 })

    await startSession(paths, {
      sessionName: 'relaymind-main',
      tmuxFn: tmux.fn,
      profileExists: async () => false,
    })

    const newSession = tmux.calls.find((c) => c.args[0] === 'new-session')!
    const args = [...newSession.args]
    const dashDash = args.indexOf('--')
    expect(args.slice(dashDash + 1)).toEqual([
      'claude',
      '--name',
      'relaymind-main',
      '--channels',
      CHANNEL_TELEGRAM,
      SKIP_PERMS,
    ])

    const log = await readFile(join(paths.supervisorStateDir, 'supervisor.log'), 'utf8')
    expect(log).toContain("profile 'missing-profile' not found")
    expect(log).toContain('runner=bare-claude')
  })

  it('forwards --resume after the second `--` so viberelay run treats it as a claude flag', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.claudeHome, { recursive: true })
    await mkdir(paths.stateRoot, { recursive: true })
    await mkdir(paths.supervisorStateDir, { recursive: true })
    await writeFile(
      paths.configJson,
      JSON.stringify({ sessionName: 'relaymind-main', viberelayProfile: { name: 'relaymind' } }),
      'utf8',
    )
    const previous: SupervisorSessionMeta = {
      sessionName: 'relaymind-main',
      claudeSessionId: 'sess-xyz',
      pid: 1,
      startedAt: '2026-04-26T00:00:00.000Z',
      status: 'stopped',
    }
    await writeFile(paths.sessionFile, JSON.stringify(previous), 'utf8')
    const tmux = makeTmuxFake({ panePid: 12 })

    await startSession(paths, {
      resume: true,
      tmuxFn: tmux.fn,
      profileExists: async () => true,
    })

    const newSession = tmux.calls.find((c) => c.args[0] === 'new-session')!
    const args = [...newSession.args]
    const dashDash = args.indexOf('--')
    expect(args.slice(dashDash + 1)).toEqual([
      'viberelay',
      'run',
      '-d',
      'relaymind',
      '--name',
      'relaymind-main',
      '--resume',
      'sess-xyz',
      '--channels',
      CHANNEL_TELEGRAM,
    ])
  })

  it('appends extraClaudeArgs verbatim after the standard flags', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.claudeHome, { recursive: true })
    const tmux = makeTmuxFake({ panePid: 1 })
    await startSession(paths, {
      sessionName: 'relaymind-main',
      tmuxFn: tmux.fn,
      extraClaudeArgs: ['--model', 'opus-4-5'],
    })
    const newSession = tmux.calls.find((c) => c.args[0] === 'new-session')!
    const args = [...newSession.args]
    const dashDash = args.indexOf('--')
    expect(args.slice(dashDash + 1)).toEqual([
      'claude',
      '--name',
      'relaymind-main',
      '--channels',
      CHANNEL_TELEGRAM,
      SKIP_PERMS,
      '--model',
      'opus-4-5',
    ])
  })
})

// ─── buildClaudeArgs (pure shape) ───────────────────────────────────────────

describe('supervisor.buildClaudeArgs', () => {
  it('emits skip-permissions and the telegram channel when no sessionName is given', () => {
    const args = buildClaudeArgs({ resumeArgs: [] })
    expect(args).not.toContain('--name')
    expect(args).toEqual(['--channels', CHANNEL_TELEGRAM, SKIP_PERMS])
  })

  it('emits --name when sessionName is provided', () => {
    const args = buildClaudeArgs({ resumeArgs: [], sessionName: 'relaymind-main' })
    expect(args.slice(0, 2)).toEqual(['--name', 'relaymind-main'])
    expect(args).toContain(SKIP_PERMS)
  })

  it('places --name then --resume before skip-perms', () => {
    const args = buildClaudeArgs({
      resumeArgs: ['--resume', 'sess-1'],
      sessionName: 'relaymind-main',
    })
    expect(args.slice(0, 4)).toEqual(['--name', 'relaymind-main', '--resume', 'sess-1'])
    expect(args).toContain(SKIP_PERMS)
  })

  it('appends extras at the end', () => {
    const args = buildClaudeArgs({ resumeArgs: [], extra: ['--foo', 'bar'] })
    expect(args.slice(-2)).toEqual(['--foo', 'bar'])
  })

  it('omits skip-perms when runner injects it', () => {
    const args = buildClaudeArgs({ resumeArgs: [], skipPermsInjectedByRunner: true })
    expect(args).not.toContain(SKIP_PERMS)
  })
})

// ─── stopSession ────────────────────────────────────────────────────────────

describe('supervisor.stopSession', () => {
  it('sends C-c then kill-session when the tmux session is running', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.supervisorStateDir, { recursive: true })
    await writeFile(paths.pidFile, '4242\n', 'utf8')
    await writeFile(
      paths.sessionFile,
      JSON.stringify({
        sessionName: 'relaymind-main',
        pid: 4242,
        startedAt: '2026-04-27T00:00:00.000Z',
        status: 'running',
      } satisfies SupervisorSessionMeta),
      'utf8',
    )
    const tmux = makeTmuxFake({ initiallyRunning: new Set(['relaymind-main']) })

    const r = await stopSession(paths, { graceMs: 0, tmuxFn: tmux.fn })

    expect(r).toEqual({ stopped: true, pid: 4242 })
    const verbs = tmux.calls.map((c) => c.args[0])
    // Should include has-session, send-keys (C-c), kill-session in that order.
    expect(verbs).toContain('send-keys')
    expect(verbs).toContain('kill-session')
    const sendKeysCall = tmux.calls.find((c) => c.args[0] === 'send-keys')
    expect(sendKeysCall!.args).toEqual(['send-keys', '-t', 'relaymind-main', 'C-c'])
    await expect(stat(paths.pidFile)).rejects.toThrow()
    const meta = JSON.parse(await readFile(paths.sessionFile, 'utf8')) as SupervisorSessionMeta
    expect(meta.status).toBe('stopped')
    expect(tmux.running.has('relaymind-main')).toBe(false)
  })

  it('is idempotent when no tmux session exists', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake()
    const r = await stopSession(paths, { tmuxFn: tmux.fn })
    expect(r.stopped).toBe(false)
    // No send-keys/kill-session because the session was absent.
    const verbs = tmux.calls.map((c) => c.args[0])
    expect(verbs).not.toContain('send-keys')
    expect(verbs).not.toContain('kill-session')
  })

  it('cleans up a stale pid file when no tmux session exists', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.supervisorStateDir, { recursive: true })
    await writeFile(paths.pidFile, '9999\n', 'utf8')
    const tmux = makeTmuxFake()
    const r = await stopSession(paths, { tmuxFn: tmux.fn })
    expect(r.stopped).toBe(false)
    await expect(stat(paths.pidFile)).rejects.toThrow()
  })
})

// ─── getStatus / runHealthCheck ─────────────────────────────────────────────

describe('supervisor.getStatus / runHealthCheck', () => {
  it('reports stopped when no session meta is present', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake()
    const { health, meta } = await getStatus(paths, { tmuxFn: tmux.fn })
    expect(health.status).toBe('stopped')
    expect(meta).toBeNull()
  })

  it('reports stopped with detail "no tmux session" when meta exists but tmux says no', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.supervisorStateDir, { recursive: true })
    await writeFile(
      paths.sessionFile,
      JSON.stringify({
        sessionName: 'relaymind-main',
        pid: 12345,
        startedAt: '2026-04-27T00:00:00.000Z',
        status: 'running',
      } satisfies SupervisorSessionMeta),
      'utf8',
    )
    const tmux = makeTmuxFake()
    const { health, meta } = await getStatus(paths, { tmuxFn: tmux.fn })
    expect(health.status).toBe('stopped')
    expect(health.detail).toContain('no tmux session')
    expect(meta?.status).toBe('stopped')
  })

  it('reports running when the tmux session is alive and no transcript path is set', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.supervisorStateDir, { recursive: true })
    await writeFile(
      paths.sessionFile,
      JSON.stringify({
        sessionName: 'relaymind-main',
        pid: 12345,
        startedAt: '2026-04-27T00:00:00.000Z',
        status: 'starting',
      } satisfies SupervisorSessionMeta),
      'utf8',
    )
    const tmux = makeTmuxFake({ initiallyRunning: new Set(['relaymind-main']) })
    const { health } = await getStatus(paths, { tmuxFn: tmux.fn })
    expect(health.status).toBe('running')
  })

  it('reports unhealthy when tmux is alive but the transcript is silent past the threshold', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.supervisorStateDir, { recursive: true })
    const transcriptPath = join(workspace, 'transcript.jsonl')
    await writeFile(transcriptPath, 'line\n', 'utf8')
    // Backdate the transcript by 10 minutes.
    const old = new Date(Date.now() - 10 * 60_000)
    const { utimes } = await import('node:fs/promises')
    await utimes(transcriptPath, old, old)

    await writeFile(
      paths.sessionFile,
      JSON.stringify({
        sessionName: 'relaymind-main',
        pid: 12345,
        startedAt: '2026-04-27T00:00:00.000Z',
        status: 'running',
        transcriptPath,
      } satisfies SupervisorSessionMeta),
      'utf8',
    )
    const tmux = makeTmuxFake({ initiallyRunning: new Set(['relaymind-main']) })
    const { health } = await getStatus(paths, { tmuxFn: tmux.fn })
    expect(health.status).toBe('unhealthy')
    expect(health.detail).toMatch(/transcript silent/)
  })

  it('runHealthCheck returns the same status and writes a log line that notes tmux presence', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake()
    const h = await runHealthCheck(paths, { tmuxFn: tmux.fn })
    expect(h.status).toBe('stopped')
    const log = await readFile(join(paths.supervisorStateDir, 'supervisor.log'), 'utf8')
    expect(log).toContain('health status=stopped')
    expect(log).toContain('tmux=')
  })

  it('tailLogs returns the last N lines and handles a missing log gracefully', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake()
    expect(await tailLogs(paths, 10)).toEqual([])
    await runHealthCheck(paths, { tmuxFn: tmux.fn })
    await runHealthCheck(paths, { tmuxFn: tmux.fn })
    const tail = await tailLogs(paths, 1)
    expect(tail).toHaveLength(1)
    expect(tail[0]).toContain('health status=stopped')
  })
})

// ─── sendKeys / attachSession / capturePane ─────────────────────────────────

describe('supervisor.sendKeys', () => {
  it('rejects when no tmux session is running', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake()
    await expect(sendKeys(paths, 'hello', { tmuxFn: tmux.fn })).rejects.toThrow(/no tmux session/)
  })

  it("calls send-keys -- 'text' Enter when the session is running", async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake({ initiallyRunning: new Set(['relaymind-main']) })
    await sendKeys(paths, '/restart now', { tmuxFn: tmux.fn })
    const call = tmux.calls.find((c) => c.args[0] === 'send-keys')
    expect(call!.args).toEqual(['send-keys', '-t', 'relaymind-main', '--', '/restart now', 'Enter'])
  })
})

describe('supervisor.attachSession', () => {
  it('returns the tmux command and reports running when present', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake({ initiallyRunning: new Set(['relaymind-main']) })
    const info = await attachSession(paths, { tmuxFn: tmux.fn })
    expect(info.bin).toBe('tmux')
    expect(info.args).toEqual(['attach-session', '-t', 'relaymind-main'])
    expect(info.sessionName).toBe('relaymind-main')
    expect(info.running).toBe(true)
  })

  it('reports running=false when no session is present', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake()
    const info = await attachSession(paths, { tmuxFn: tmux.fn })
    expect(info.running).toBe(false)
  })
})

describe('supervisor.capturePane', () => {
  it('returns empty when no session is running', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake()
    expect(await capturePane(paths, 100, { tmuxFn: tmux.fn })).toEqual([])
  })

  it('returns captured lines when the session exists', async () => {
    const paths = relayMindPaths(workspace)
    const tmux = makeTmuxFake({ initiallyRunning: new Set(['relaymind-main']) })
    const lines = await capturePane(paths, 50, { tmuxFn: tmux.fn })
    expect(lines).toEqual(['line1', 'line2'])
    const call = tmux.calls.find((c) => c.args[0] === 'capture-pane')
    expect(call!.args).toEqual(['capture-pane', '-t', 'relaymind-main', '-p', '-S', '-50'])
  })
})

// ─── Registry snapshot / rollback (unchanged) ───────────────────────────────

describe('supervisor.registry snapshot/rollback', () => {
  it('round-trips: snapshot then rollback restores the original bytes', async () => {
    const paths = relayMindPaths(workspace)
    await mkdir(paths.commandsDir, { recursive: true })
    const original = JSON.stringify({ commands: [{ name: 'good', description: 'x', mode: 'direct', handler: 'good' }] }, null, 2)
    await writeFile(paths.registryJson, original, 'utf8')

    const snapshotted = await snapshotRegistry(paths)
    expect(snapshotted).toBe(true)
    expect(await readFile(paths.lastGoodRegistry, 'utf8')).toBe(original)

    // Simulate a Claude-initiated bad edit.
    await writeFile(paths.registryJson, '{ "commands": [ "broken"', 'utf8')
    await rollbackRegistry(paths)
    expect(await readFile(paths.registryJson, 'utf8')).toBe(original)
  })

  it('snapshotRegistry returns false when no registry exists yet', async () => {
    const paths = relayMindPaths(workspace)
    expect(await snapshotRegistry(paths)).toBe(false)
  })

  it('rollbackRegistry throws when no last-good snapshot exists (PRD §867-877: no silent disable)', async () => {
    const paths = relayMindPaths(workspace)
    await expect(rollbackRegistry(paths)).rejects.toThrow(/no last-good registry/)
  })
})
