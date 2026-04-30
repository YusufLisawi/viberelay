/**
 * Minimal ambient declarations for `bun:sqlite` so the package typechecks
 * without depending on `bun-types`. Only the surface we actually use.
 *
 * Runtime is Bun — `import { Database } from 'bun:sqlite'` is a built-in.
 */
declare module 'bun:sqlite' {
  export type SQLQueryBindings =
    | string
    | number
    | bigint
    | boolean
    | null
    | Uint8Array
    | Record<string, string | number | bigint | boolean | null | Uint8Array>

  export interface Statement<TRow = unknown> {
    all(...params: SQLQueryBindings[]): TRow[]
    get(...params: SQLQueryBindings[]): TRow | undefined
    run(...params: SQLQueryBindings[]): { lastInsertRowid: number | bigint; changes: number }
    values(...params: SQLQueryBindings[]): unknown[][]
    finalize(): void
  }

  export interface DatabaseOptions {
    readonly?: boolean
    create?: boolean
    readwrite?: boolean
    strict?: boolean
  }

  export class Database {
    constructor(filename?: string, options?: DatabaseOptions | number)
    prepare<TRow = unknown>(sql: string): Statement<TRow>
    exec(sql: string): void
    run(sql: string, ...params: SQLQueryBindings[]): { lastInsertRowid: number | bigint; changes: number }
    query<TRow = unknown>(sql: string): Statement<TRow>
    transaction<T extends (...args: never[]) => unknown>(fn: T): T
    close(): void
  }
}
