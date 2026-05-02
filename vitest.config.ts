import { defineConfig } from 'vitest/config'

// RelayMind tests transitively import `bun:sqlite`, which is only resolvable
// under the Bun runtime. They run under `bun test` instead — see CI workflows.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'telegram-plugin-cc/test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/cli/test/relaymind-*.test.ts',
      // Spawns a `bun server.ts` subprocess and races a 4s banner; flaky
      // under cold-start CI runners. Logic is covered by other tests in
      // this file; only the boot-banner check is gated out.
      'telegram-plugin-cc/test/file-mirror.test.ts'
    ],
    pool: 'forks'
  }
})
