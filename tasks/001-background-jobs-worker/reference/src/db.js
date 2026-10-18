import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DEFAULT_DATABASE_PATH = './data/jobs.sqlite';

const SCHEMA = `
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
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'running') = (claim_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (state <> 'completed' OR result IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (created_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (lease_until) WHERE state = 'running';
`;

export function openDb(file = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
