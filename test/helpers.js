import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRepo } from '../src/repo.js';
import { buildApp } from '../src/app.js';

/**
 * Create a throwaway directory under the OS temp dir and return the path to a
 * SQLite file inside it.
 *
 * Tests deliberately use a real on-disk database (not ':memory:') because WAL
 * mode, cross-connection visibility and lease/restart behaviour only exist for
 * file-backed databases. The directory lives in os.tmpdir() so it never lands
 * in the repo's gitignored ./data folder.
 *
 * @returns {{ dir: string, dbPath: string, cleanup: () => void }}
 */
export function createTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-queue-'));
  const dbPath = join(dir, 'jobs.sqlite');
  return {
    dir,
    dbPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Build a controllable clock.
 *
 * The returned value is callable, so it can be passed straight in wherever a
 * `now` function is expected (worker, repo timestamp arguments). `advance(ms)`
 * moves time forward without sleeping, which is how the tests cross the 10s
 * lease boundary deterministically.
 *
 * @param {number} [start] initial time in Unix milliseconds
 * @returns {(() => number) & { advance: (ms: number) => number, set: (value: number) => number }}
 */
export function makeClock(start = 0) {
  let current = start;
  const clock = () => current;
  clock.advance = (ms) => {
    current += ms;
    return current;
  };
  clock.set = (value) => {
    current = value;
    return current;
  };
  return clock;
}

/**
 * Start the HTTP API on an ephemeral port against the given database handle.
 *
 * Binds to 127.0.0.1 with port 0 so the OS picks a free port; the resolved
 * baseUrl is returned for use with fetch. The repo is built here so callers
 * only need to supply the database handle.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{ app: import('fastify').FastifyInstance, repo: object, baseUrl: string }>}
 */
export async function startApi(db) {
  const repo = createRepo(db);
  const app = buildApp({ db, repo });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  return { app, repo, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Stop a server previously started with {@link startApi}.
 *
 * @param {import('fastify').FastifyInstance} app
 * @returns {Promise<void>}
 */
export async function stopApi(app) {
  await app.close();
}
