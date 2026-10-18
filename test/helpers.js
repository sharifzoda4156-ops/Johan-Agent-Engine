//
// Shared helpers for the acceptance tests.
//
// These utilities keep the tests integration-level: every test runs against a
// real, file-backed SQLite database created in the OS temp directory, uses a
// controllable clock (so we never have to `sleep` to advance leases), drives
// the API through Fastify's `inject` (no network), and runs the worker loop
// with an injectable `processJob` (so failures are deterministic).
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildServer } from '../src/api.js';
import { closeDb, openDb } from '../src/db.js';
import { runWorker } from '../src/worker.js';

/**
 * Create a controllable clock.
 *
 * Returns a function that behaves like `Date.now` but whose value can be
 * advanced explicitly via `clock.advance(ms)` or set via `clock.set(ms)`.
 * This lets tests move past a lease without waiting in real time.
 *
 * @param {number} [start] initial epoch millis (defaults to a fixed value)
 * @returns {Function & { advance: (ms: number) => number, set: (ms: number) => number, now: () => number }}
 */
export function createClock(start = 1_700_000_000_000) {
  let current = start;

  const clock = () => current;
  clock.advance = (ms) => {
    current += ms;
    return current;
  };
  clock.set = (ms) => {
    current = ms;
    return current;
  };
  clock.now = () => current;

  return clock;
}

/**
 * Create a temporary, file-backed SQLite database.
 *
 * The database lives in a fresh directory under `os.tmpdir()` so that WAL
 * sidecar files (`-wal`/`-shm`) are isolated per test. The returned handle
 * exposes the path, the open `db`, and a `cleanup()` that closes the database
 * and removes the temp directory.
 *
 * @param {object} [options]
 * @param {string} [options.prefix] directory name prefix
 * @returns {{ path: string, dir: string, db: object, cleanup: () => void }}
 */
export function createTempDb({ prefix = 'jobs-test-' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'jobs.sqlite');
  const db = openDb(dbPath);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { path: dbPath, dir, db, cleanup };
}

/**
 * Build a Fastify API instance wired to the given database and clock.
 *
 * The instance is not listening on a socket; tests drive it with
 * `app.inject(...)`. Call `app.close()` (or use `createApi`'s cleanup) when
 * done.
 *
 * @param {object} options
 * @param {object} options.db   better-sqlite3 database handle
 * @param {Function} options.now controllable clock
 * @returns {import('fastify').FastifyInstance}
 */
export function createApi({ db, now }) {
  return buildServer({ db, now });
}

/**
 * Convenience wrapper that creates a temp DB, a clock, and an API instance,
 * and returns a single `cleanup()` that tears everything down.
 *
 * @param {object} [options]
 * @param {number} [options.start] initial clock value
 * @param {string} [options.prefix] temp dir prefix
 * @returns {Promise<{ db: object, dbPath: string, clock: Function, app: object, cleanup: () => Promise<void> }>}
 */
export async function createApiFixture({ start, prefix } = {}) {
  const temp = createTempDb({ prefix });
  const clock = createClock(start);
  const app = createApi({ db: temp.db, now: clock });

  const cleanup = async () => {
    try {
      await app.close();
    } finally {
      temp.cleanup();
    }
  };

  return { db: temp.db, dbPath: temp.path, clock, app, cleanup };
}

/**
 * Run the worker loop until it stops.
 *
 * The loop is driven by an `AbortController`; `runWorker` resolves once the
 * abort is observed. `processJob` is injectable so tests can simulate
 * controlled failures. `pollIntervalMs` defaults to a small value so idle
 * ticks are quick, but tests should prefer to have work available so the loop
 * never actually waits.
 *
 * @param {object} options
 * @param {object} options.db
 * @param {Function} options.now
 * @param {number} options.leaseMs
 * @param {number} options.maxAttempts
 * @param {Function} [options.processJob]
 * @param {number} [options.pollIntervalMs]
 * @returns {{ promise: Promise<void>, stop: () => void, signal: AbortSignal }}
 */
export function startWorker({
  db,
  now,
  leaseMs,
  maxAttempts,
  processJob,
  pollIntervalMs = 5,
}) {
  const controller = new AbortController();

  const promise = runWorker({
    db,
    now,
    leaseMs,
    maxAttempts,
    processJob,
    pollIntervalMs,
    signal: controller.signal,
  });

  return {
    promise,
    signal: controller.signal,
    stop: () => controller.abort(),
  };
}

/**
 * Run the worker for a single "tick" and stop it.
 *
 * This is a convenience for tests that want to process exactly the jobs that
 * are currently claimable without leaving a background loop running. It starts
 * the worker, waits until the queue is drained (or a bounded number of ticks
 * elapse), then aborts and awaits the loop.
 *
 * @param {object} options same as `startWorker`
 * @param {number} [options.maxTicks] safety bound on idle ticks
 * @returns {Promise<void>}
 */
export async function runWorkerOnce({
  db,
  now,
  leaseMs,
  maxAttempts,
  processJob,
  pollIntervalMs = 5,
  maxTicks = 50,
}) {
  const controller = new AbortController();
  let ticks = 0;

  // Wrap the clock so we can count idle ticks and stop after a bound. We do
  // not advance time here; tests control the clock explicitly.
  const countingNow = () => {
    ticks += 1;
    if (ticks > maxTicks) {
      controller.abort();
    }
    return now();
  };

  await runWorker({
    db,
    now: countingNow,
    leaseMs,
    maxAttempts,
    processJob,
    pollIntervalMs,
    signal: controller.signal,
  });
}

/**
 * Small helper to POST a job through the API and return the parsed response.
 *
 * @param {object} app Fastify instance
 * @param {object} body request body
 * @param {object} [options]
 * @param {string} [options.idempotencyKey]
 * @returns {Promise<{ statusCode: number, json: () => any, headers: object }>}
 */
export function postJob(app, body, { idempotencyKey } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (idempotencyKey !== undefined) {
    headers['idempotency-key'] = idempotencyKey;
  }
  return app.inject({
    method: 'POST',
    url: '/jobs',
    headers,
    payload: JSON.stringify(body),
  });
}

/**
 * Small helper to GET a job through the API.
 *
 * @param {object} app Fastify instance
 * @param {string} id job id
 * @returns {Promise<{ statusCode: number, json: () => any }>}
 */
export function getJob(app, id) {
  return app.inject({ method: 'GET', url: `/jobs/${id}` });
}

/**
 * Small helper to cancel a job through the API.
 *
 * @param {object} app Fastify instance
 * @param {string} id job id
 * @returns {Promise<{ statusCode: number, json: () => any }>}
 */
export function cancelJob(app, id) {
  return app.inject({ method: 'POST', url: `/jobs/${id}/cancel` });
}
