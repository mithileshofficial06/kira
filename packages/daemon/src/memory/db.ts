/**
 * The memory database (spec §9.3): one SQLite file per workspace at
 * .kira/memory.db, on Node's built-in node:sqlite (FTS5 included, no native
 * build). Vectors are stored as Float32 blobs and scored in JS: a workspace
 * holds thousands of items, not millions, so brute-force cosine is fast and
 * avoids loading an extension.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  store       TEXT NOT NULL CHECK (store IN ('episodic', 'semantic', 'procedural', 'preference')),
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  files       TEXT NOT NULL DEFAULT '[]',
  signature   TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rejected', 'superseded')),
  review      TEXT NOT NULL DEFAULT 'none' CHECK (review IN ('none', 'pending', 'kept')),
  source      TEXT NOT NULL DEFAULT 'run',
  run_id      TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  supersedes  INTEGER REFERENCES items(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_store ON items(store, status);
CREATE INDEX IF NOT EXISTS items_signature ON items(signature);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, body, content='items', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title, body ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO items_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- One row per (item, model): vectors from different models are never compared.
CREATE TABLE IF NOT EXISTS embeddings (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  model   TEXT NOT NULL,
  dim     INTEGER NOT NULL,
  vec     BLOB NOT NULL,
  PRIMARY KEY (item_id, model)
);

-- What was retrieved for which query: the evidence for tuning retrieval (risk R8).
CREATE TABLE IF NOT EXISTS retrieval_log (
  id       INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  query    TEXT NOT NULL,
  item_ids TEXT NOT NULL,
  reranked INTEGER NOT NULL
);
`;

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array): Float32Array {
  // Copy: the driver's buffer may not be 4-byte aligned.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
