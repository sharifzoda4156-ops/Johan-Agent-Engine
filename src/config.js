// src/config.js
//
// Central configuration shared by the API process (src/api.js) and the worker
// process (src/worker.js).
//
// Only DATABASE_PATH and PORT are read from the environment; both are documented
// in ecosystem.config.example.js. LEASE_MS and MAX_ATTEMPTS are fixed constants
// of the job protocol, so they are intentionally NOT env-driven (adding a new
// env variable would require documenting it in ecosystem.config.example.js).
//
// loadConfig() is pure: it does not create directories or open the database.
// The SQLite file is created by openDb(path) in the DB layer.

export const DEFAULT_DATABASE_PATH = './data/jobs.sqlite';
export const DEFAULT_PORT = 3000;
export const LEASE_MS = 10000;
export const MAX_ATTEMPTS = 3;

function readPort(env) {
  const raw = env.PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_PORT;
  }
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `Invalid PORT: expected an integer in 1..65535, got "${raw}"`
    );
  }
  return value;
}

function readDatabasePath(env) {
  const raw = env.DATABASE_PATH;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_DATABASE_PATH;
  }
  return String(raw);
}

export function loadConfig(env = process.env) {
  return {
    databasePath: readDatabasePath(env),
    port: readPort(env),
    leaseMs: LEASE_MS,
    maxAttempts: MAX_ATTEMPTS,
  };
}

export default loadConfig;
