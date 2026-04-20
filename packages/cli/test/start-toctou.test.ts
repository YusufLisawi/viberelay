/**
 * Tests for Fix A: PID-file TOCTOU in `viberelay start`.
 *
 * Two concurrent calls to runStartCommand must only spawn one daemon, regardless
 * of the check-then-spawn race window. We verify this via an exclusive lock file
 * that is acquired before the check-and-spawn critical section.
 */
import { writeFile, mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireLock, releaseLock, resolveDaemonPaths } from '../src/lib/daemon-control.js'

// We import the module under test AFTER we set env vars in beforeEach, but
// vitest re-uses the same module instance — so we rely on the env vars being
// read lazily inside resolveDaemonPaths() each call.
import { runStartCommand } from '../src/commands/start.js'

let tempState: string
const originalEnv = {
  state: process.env.VIBERELAY_STATE_DIR,
  bin: process.env.VIBERELAY_DAEMON_BINARY,
}

beforeEach(async () => {
  tempState = await mkdtemp(join(tmpdir(), 'viberelay-toctou-'))
  process.env.VIBERELAY_STATE_DIR = tempState
  // Use a non-existent binary so spawnDaemon throws ENOENT if it is reached
  // unexpectedly. Individual tests override this when they need a real spawn.
  process.env.VIBERELAY_DAEMON_BINARY = '/nonexistent-binary-for-toctou-test'
})

afterEach(async () => {
  process.env.VIBERELAY_STATE_DIR = originalEnv.state
  process.env.VIBERELAY_DAEMON_BINARY = originalEnv.bin
  await rm(tempState, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('start TOCTOU lock', () => {
  it('acquireLock returns true the first time and false on a second concurrent call', async () => {
    const paths = resolveDaemonPaths()
    const first = await acquireLock(paths)
    const second = await acquireLock(paths)
    expect(first).toBe(true)
    expect(second).toBe(false)
    await releaseLock(paths)
  })

  it('acquireLock recovers a stale lock left by a dead process', async () => {
    const { mkdir } = await import('node:fs/promises')
    const paths = resolveDaemonPaths()
    await mkdir(paths.stateDir, { recursive: true })

    // Write a lock file with a PID that is definitely not alive.
    // PID 1 is init on Linux and launchd on macOS — it's alive. Use a
    // very high PID that is almost certainly not running.
    // To avoid any chance of a real process, write an invalid PID.
    await writeFile(paths.lockFile, '2147483647\n', 'utf8') // INT_MAX, always dead

    // No PID file → the daemon is not running either → lock is stale.
    const recovered = await acquireLock(paths)
    expect(recovered).toBe(true)
    await releaseLock(paths)
  })

  it('concurrent runStartCommand calls only attempt to spawn once when binary is present', async () => {
    // Use /bin/sleep (always present on unix) as a stand-in daemon so spawnDaemon
    // succeeds but the "daemon" never actually starts listening.
    const sleepBin = process.platform === 'win32' ? process.execPath : '/bin/sleep'
    process.env.VIBERELAY_DAEMON_BINARY = sleepBin

    // Import daemon-control to spy on spawnDaemon at the module level.
    const daemonControl = await import('../src/lib/daemon-control.js')
    const spawnSpy = vi.spyOn(daemonControl, 'spawnDaemon')

    // Both calls race — we await them in parallel.
    const results = await Promise.allSettled([
      runStartCommand({ baseUrl: 'http://127.0.0.1:59998', wait: false }),
      runStartCommand({ baseUrl: 'http://127.0.0.1:59998', wait: false }),
    ])

    // Count how many times spawnDaemon was actually invoked.
    const spawnCallCount = spawnSpy.mock.calls.length

    // At most one spawn should have happened.
    expect(spawnCallCount).toBeLessThanOrEqual(1)

    // At least one result must be a fulfilled "started" or "already running"
    // message — the system must not silently drop both.
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    // The messages should make sense: either "started" or "already running"
    // or "start already in progress".
    for (const result of fulfilled) {
      const value = (result as PromiseFulfilledResult<string>).value
      expect(value).toMatch(/started|already running|already in progress/i)
    }
  })

  it('lock file is removed after a successful start', async () => {
    // Use /bin/sleep so spawnDaemon succeeds.
    const sleepBin = process.platform === 'win32' ? process.execPath : '/bin/sleep'
    process.env.VIBERELAY_DAEMON_BINARY = sleepBin

    await runStartCommand({ baseUrl: 'http://127.0.0.1:59997', wait: false })

    const paths = resolveDaemonPaths()
    // After a completed start the lock must be gone (so a future start can run).
    await expect(access(paths.lockFile)).rejects.toThrow(/ENOENT/)
  })

  it('lock file is removed after a failed start (binary missing)', async () => {
    // Binary is nonexistent — spawnDaemon will throw ENOENT.
    process.env.VIBERELAY_DAEMON_BINARY = '/nonexistent-binary-for-toctou-test'

    await expect(
      runStartCommand({ baseUrl: 'http://127.0.0.1:59996', wait: false })
    ).rejects.toThrow(/ENOENT|no such file/i)

    const paths = resolveDaemonPaths()
    // Even on failure the lock must be cleaned up.
    await expect(access(paths.lockFile)).rejects.toThrow(/ENOENT/)
  })

  it('stop clears the lock file alongside the PID file', async () => {
    const paths = resolveDaemonPaths()
    // Manually plant a PID file with a dead PID and a lock file.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.stateDir, { recursive: true })
    await writeFile(paths.pidFile, '99999999\n', 'utf8')
    await writeFile(paths.lockFile, '', 'utf8')

    const { runStopCommand } = await import('../src/commands/stop.js')
    await runStopCommand()

    await expect(access(paths.pidFile)).rejects.toThrow(/ENOENT/)
    await expect(access(paths.lockFile)).rejects.toThrow(/ENOENT/)
  })
})
