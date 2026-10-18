// src/db.js
//
// SQLite connection layer shared by the API process (src/api.js) and the
// worker process (src/worker.js).
//
// openDb(path) opens (creating if necessary) the SQLite database file and
// applies the connection-level PRAGMAs required by the job protocol:
//
//   journal_mode = WAL   -> allows concurrent readers with a single writer,
//                           which is what lets the API and the worker share
//                           one database file.
//   busy_timeout = 5000  -> wait up to 5s for a lock instead of failing
//                           immediately with SQLITE_BUSY.
//   foreign_keys = ON    -> enforce foreign key constraints (defensive; the
//                           current schema has no FKs, but this keeps the
//                           connection consistent if they are added later).
//
// The database file lives under ./data/ by default, which is listed in
// .gitignore and therefore may not exist in a fresh checkout. openDb()
// creates the parent directory before opening the file so that a first run
// does not fail with SQLITE_CANTOPEN.
//
// The schema (CREATE TABLE jobs, indexes) is applied by later subpoints of
// the "SQLite schema and DB connection" item; this module currently only
// establishes the connection and its PRAGMAs.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDb(databasePath) {
  // Ensure the parent directory exists. better-sqlite3 will create the file
  // itself, but not the directory that contains it.
  const dir = path.dirname(databasePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(databasePath);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Job queue schema. Timestamps (created_at, updated_at, lease_until) are
  // Unix milliseconds. The CHECK constraints encode the job protocol:
  //   - state is one of the five known states;
  //   - attempts stays within 0..MAX_ATTEMPTS (3);
  //   - result, when present, is a non-negative integer.
  // idempotency_key is UNIQUE so that duplicate submissions are rejected by
  // the database itself rather than by a check-then-insert race.
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      text            TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      state           TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled')),
      attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
      result          INTEGER CHECK (result IS NULL OR result >= 0),
      error           TEXT,
      claim_token     TEXT,
      lease_until     INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_queue
      ON jobs (state, lease_until);

    CREATE INDEX IF NOT EXISTS idx_jobs_idempotency
      ON jobs (idempotency_key);
  `);

  return db;
}

// Close the database connection. Safe to call on an already-closed handle
// (better-sqlite3 exposes `db.open`), so callers can use it in shutdown
// paths without tracking whether the connection is still live.
export function closeDb(db) {
  if (db && db.open) {
    db.close();
  }
}
