import { defineConfig } from 'vitest/config'

// RelayMind tests transitively import `bun:sqlite`, which is only resolvable
// under the Bun runtime. They run under `bun test` instead — see CI workflows.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'telegram-plugin-cc/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/cli/test/relaymind-*.test.ts'],
    pool: 'forks'
  }
})
