import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DEFAULT_DATABASE_PATH = './data/jobs.sqlite';

/**
 * Schema for the jobs queue. Times are Unix milliseconds.
 *
 * - `idempotency_key` uniqueness is enforced by the UNIQUE constraint, not by
 *   a pre-insert lookup.
 * - `attempts` is bounded to 0..3 so a fourth claim is impossible.
 * - `idx_jobs_queue` serves the queue scan (state, created_at).
 * - `idx_jobs_lease` serves expired-lease recovery (state, lease_until).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  result INTEGER CHECK (result IS NULL OR result >= 0),
  error TEXT,
  claim_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(state, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(state, lease_until);
`;

/**
 * Open the SQLite database used by the API and the worker.
 *
 * - Resolves the path from the argument, falling back to DATABASE_PATH
 *   (default ./data/jobs.sqlite).
 * - Creates the parent directory if it does not exist yet.
 * - Enables WAL journaling, a 5s busy timeout and foreign key enforcement.
 * - Creates the jobs table and its indexes if they do not exist yet.
 */
export function openDatabase(dbPath = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  return db;
}

/**
 * Current time in Unix milliseconds.
 *
 * All timestamps (created_at, updated_at, lease_until) go through this helper
 * so tests can substitute a controllable clock.
 */
export function now() {
  return Date.now();
}

/**
 * Close the database connection.
 *
 * Safe to call repeatedly or on an already closed handle: better-sqlite3
 * throws when closing a closed database, so the `open` flag is checked first.
 */
export function closeDatabase(db) {
  if (db && db.open) db.close();
}
