/**
 * SQLite database open + schema migration for the RelayMind memory layer.
 *
 * Uses `bun:sqlite` (zero npm dep). Schema follows PRD §521-585: an `items`
 * table, a contentless FTS5 mirror `items_fts`, and an explicit `edges` table.
 * The FTS table is kept in sync with `items` via triggers — the canonical
 * SQLite "external content" pattern.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'

const SCHEMA_VERSION = 1

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT,
  day TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_day ON items(day);
CREATE INDEX IF NOT EXISTS idx_items_importance ON items(importance DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title,
  body,
  source,
  content='items',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body, source)
  VALUES (new.id, new.title, new.body, COALESCE(new.source, ''));
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body, source)
  VALUES('delete', old.id, old.title, old.body, COALESCE(old.source, ''));
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body, source)
  VALUES('delete', old.id, old.title, old.body, COALESCE(old.source, ''));
  INSERT INTO items_fts(rowid, title, body, source)
  VALUES (new.id, new.title, new.body, COALESCE(new.source, ''));
END;

CREATE TABLE IF NOT EXISTS edges (
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  rel TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, rel),
  FOREIGN KEY (from_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel);
`

export interface OpenMemoryDbOptions {
  /** When true, treat this as an in-memory db (`:memory:`). */
  inMemory?: boolean
}

export function openMemoryDb(dbPath: string, opts: OpenMemoryDbOptions = {}): Database {
  if (!opts.inMemory) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const db = new Database(opts.inMemory ? ':memory:' : dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  db.exec(SCHEMA_SQL)
  return db
}

export function closeMemoryDb(db: Database): void {
  db.close()
}

export const SCHEMA = { version: SCHEMA_VERSION }
