import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, closeDatabase } from '../src/db.js';
import { createRepo } from '../src/repo.js';
import { createWorker, installSignalHandlers } from '../src/worker.js';
import { createTempDb, makeClock } from './helpers.js';

/**
 * Durability and shutdown integration tests.
 *
 * Every case drives a real file-backed SQLite database through the real
 * modules (`src/db.js`, `src/repo.js`, `src/worker.js`) and, for the shutdown
 * checks, through the real entrypoints (`src/api.js`, `src/worker.js`) running
 * in a child process. Time is injected with `makeClock`, and the only waiting
 * is short polling — nothing sleeps long enough to cross the 10s lease.
 */

/** Repository root so the entrypoints can be spawned with an absolute path. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_ENTRY = join(ROOT, 'src', 'api.js');
const WORKER_ENTRY = join(ROOT, 'src', 'worker.js');

/** Ceilings for "startup finished" / "process exited" waits. */
const READY_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 10_000;

/**
 * Reject if `promise` has not settled within `ms`, without leaving a pending
 * timer behind that would keep the test runner alive.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Poll `predicate` until it returns a truthy value.
 *
 * @template T
 * @param {() => T | Promise<T>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function waitFor(predicate, { timeoutMs = READY_TIMEOUT_MS, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await delay(intervalMs);
  }
}

/**
 * Ask the OS for a currently free TCP port (so the spawned API can bind it).
 *
 * @returns {Promise<number>}
 */
async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Spawn one of the repo's entrypoints as a real child process, so that signal
 * delivery is exercised end to end.
 *
 * @param {string} entry absolute path to the entrypoint module
 * @param {Record<string, string>} env extra environment variables
 */
function spawnEntrypoint(entry, env) {
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });

  let settled = false;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
  });

  return {
    child,
    exited,
    get output() {
      return output;
    },
    /**
     * Deliver `signal` and wait for the process to exit.
     *
     * @param {NodeJS.Signals} signal
     */
    async stop(signal) {
      if (settled) return exited;
      child.kill(signal);
      return withTimeout(exited, EXIT_TIMEOUT_MS, `process survived ${signal}\n${output}`);
    },
    /** SIGKILL the child if a test failed before it shut down. */
    async kill() {
      if (settled) return;
      child.kill('SIGKILL');
      await exited;
    },
  };
}

test('jobs, results, errors and idempotency keys survive a database close/reopen', () => {
  const tmp = createTempDb();
  const clock = makeClock(1_700_000_000_000);
  let db = openDatabase(tmp.dbPath);
  let repo = createRepo(db);

  try {
    // 1. A job that ran to completion: numeric result, attempts, key.
    const completed = repo.createJob({
      text: 'hello brave new world',
      idempotencyKey: 'key-completed',
    }).job;
    const firstClaim = repo.claimNext(clock());
    assert.ok(firstClaim, 'the queued job should be claimable');
    assert.equal(firstClaim.id, completed.id);
    assert.equal(repo.completeJob(firstClaim.id, firstClaim.claimToken, 4, clock()), true);

    // 2. A job that burned all three attempts: the last error is kept.
    const failed = repo.createJob({ text: 'always fails', idempotencyKey: 'key-failed' }).job;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = repo.claimNext(clock());
      assert.ok(claimed, `attempt ${attempt} should be claimable`);
      assert.equal(claimed.id, failed.id);
      assert.equal(repo.failJob(claimed.id, claimed.claimToken, `boom ${attempt}`, clock()), true);
    }

    // 3. A job whose lease expired on its third claim: terminal LEASE_EXPIRED.
    const expired = repo.createJob({ text: 'never finishes' }).job;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = repo.claimNext(clock());
      assert.ok(claimed, `attempt ${attempt} should be claimable`);
      assert.equal(claimed.id, expired.id);
      clock.advance(10_001);
    }
    assert.equal(repo.expireLease(clock()), 1);

    // 4. A cancelled job and 5. a job still waiting in the queue.
    const cancelled = repo.createJob({ text: 'cancel me' }).job;
    assert.equal(repo.cancelJob(cancelled.id).state, 'cancelled');
    const queued = repo.createJob({ text: 'still queued', idempotencyKey: 'key-queued' }).job;

    const ids = [completed.id, failed.id, expired.id, cancelled.id, queued.id];
    const before = ids.map((id) => repo.getJob(id));
    assert.ok(before.every(Boolean), 'every job should be readable before the restart');

    const rowsBefore = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    assert.equal(rowsBefore.length, ids.length, 'every job should be on disk');

    const states = Object.fromEntries(before.map((job) => [job.id, job.state]));
    assert.equal(states[completed.id], 'completed');
    assert.equal(states[failed.id], 'failed');
    assert.equal(states[expired.id], 'failed');
    assert.equal(states[cancelled.id], 'cancelled');
    assert.equal(states[queued.id], 'queued');

    const row = (id) => rowsBefore.find((candidate) => candidate.id === id);
    assert.equal(row(completed.id).result, 4, 'the numeric result is persisted');
    assert.equal(row(failed.id).error, 'boom 3', 'the last failure reason is persisted');
    assert.equal(row(expired.id).error, 'LEASE_EXPIRED');
    assert.equal(row(queued.id).idempotency_key, 'key-queued');

    // Restart: the handle is closed (the old process is gone), then reopened on
    // the exact same file path with a brand new handle and repository.
    closeDatabase(db);
    assert.equal(db.open, false);

    db = openDatabase(tmp.dbPath);
    repo = createRepo(db);

    assert.deepEqual(
      ids.map((id) => repo.getJob(id)),
      before,
      'job objects should be identical after reopening the file'
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      rowsBefore,
      'the rows themselves should be identical after reopening the file'
    );

    // The UNIQUE idempotency keys survived too: replays reuse, conflicts clash.
    const replay = repo.createJob({
      text: 'hello brave new world',
      idempotencyKey: 'key-completed',
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.job.id, completed.id);

    assert.throws(
      () => repo.createJob({ text: 'a different text', idempotencyKey: 'key-completed' }),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, ids.length);
  } finally {
    closeDatabase(db);
    tmp.cleanup();
  }
});

test('a job claimed before a restart is recovered once its lease expires', async () => {
  const tmp = createTempDb();
  const clock = makeClock(1_700_000_000_000);
  let db = openDatabase(tmp.dbPath);
  let repo = createRepo(db);
  let job;

  try {
    ({ job } = repo.createJob({ text: 'survives a restart', idempotencyKey: 'key-restart' }));

    // A worker claims the job and dies before writing anything.
    const crashed = repo.claimNext(clock());
    assert.ok(crashed, 'the first claim should succeed');
    assert.equal(crashed.id, job.id);
    assert.equal(crashed.attempts, 1);

    // Crash: the process disappears, but the claim and its lease stay on disk.
    closeDatabase(db);

    db = openDatabase(tmp.dbPath);
    repo = createRepo(db);

    const stored = repo.getJob(job.id);
    assert.equal(stored.state, 'running');
    assert.equal(stored.attempts, 1);
    assert.ok(stored.leaseUntil > clock(), 'the persisted lease should still be in the future');

    // While the lease is live nothing else may claim the job...
    const early = createWorker({ repo, now: clock });
    assert.equal(await early.runOnce(), false);

    // ...once it expires the restarted worker picks it up and finishes it.
    clock.advance(10_001);
    const worker = createWorker({ repo, now: clock });
    assert.equal(await worker.runOnce(), true);

    const done = repo.getJob(job.id);
    assert.equal(done.state, 'completed');
    assert.equal(done.result, 3);
    assert.equal(done.attempts, 2);
  } finally {
    closeDatabase(db);
    tmp.cleanup();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`the worker stops its loop and closes the database on ${signal}`, async () => {
    const tmp = createTempDb();
    const db = openDatabase(tmp.dbPath);
    const repo = createRepo(db);
    const worker = createWorker({ db, repo, now: makeClock(1_700_000_000_000) });

    /** @type {Array<number | undefined>} */
    const exits = [];
    const uninstall = installSignalHandlers(worker, {
      signals: [signal],
      exit: (code) => exits.push(code),
    });

    try {
      const started = worker.start();
      assert.equal(worker.running, true);

      process.emit(signal);

      await withTimeout(
        waitFor(() => exits.length === 1, { timeoutMs: 5_000 }),
        5_000,
        `the worker did not handle ${signal}`
      );
      await withTimeout(started, 5_000, 'the worker loop did not stop');

      assert.equal(worker.running, false);
      assert.equal(db.open, false, 'shutdown should close the database handle');
      const [code] = exits;
      assert.ok(code === undefined || code === 0, `expected a clean exit code, got ${code}`);
    } finally {
      if (typeof uninstall === 'function') uninstall();
      closeDatabase(db);
      tmp.cleanup();
    }
  });
}

test('a worker process resumed on an existing database finishes a queued job and exits cleanly on SIGINT', async () => {
  const tmp = createTempDb();

  // The "previous run" leaves a queued job behind on disk.
  const setup = openDatabase(tmp.dbPath);
  const { job } = createRepo(setup).createJob({
    text: 'survives the restart',
    idempotencyKey: 'key-worker-restart',
  });
  closeDatabase(setup);

  const child = spawnEntrypoint(WORKER_ENTRY, { DATABASE_PATH: tmp.dbPath });
  const observer = openDatabase(tmp.dbPath);
  const repo = createRepo(observer);

  try {
    // The fresh worker process picks the job up and stores the real result.
    const done = await withTimeout(
      waitFor(
        () => {
          const current = repo.getJob(job.id);
          return current && current.state === 'completed' ? current : null;
        },
        { intervalMs: 25 }
      ),
      READY_TIMEOUT_MS,
      `the restarted worker never completed the queued job\n${child.output}`
    );
    assert.equal(done.result, 3);
    assert.equal(done.attempts, 1);

    const { code, signal } = await child.stop('SIGINT');
    assert.equal(signal, null, 'the worker should exit through its signal handler');
    assert.equal(code, 0);

    // Nothing is left half-written: the same file still exposes the result.
    const persisted = repo.getJob(job.id);
    assert.equal(persisted.state, 'completed');
    assert.equal(persisted.result, 3);
  } finally {
    await child.kill();
    closeDatabase(observer);
    tmp.cleanup();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`the API process persists its jobs and shuts down cleanly on ${signal}`, async () => {
    const tmp = createTempDb();
    const port = await getFreePort();
    const child = spawnEntrypoint(API_ENTRY, {
      DATABASE_PATH: tmp.dbPath,
      PORT: String(port),
      HOST: '127.0.0.1',
    });

    try {
      // Poll until the server answers; the idempotency key keeps the retries
      // from ever creating a second job.
      const created = await withTimeout(
        waitFor(
          async () => {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/jobs`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'idempotency-key': 'api-restart-key',
                },
                body: JSON.stringify({ text: 'persist me' }),
              });
              if (res.status !== 201 && res.status !== 200) return null;
              return await res.json();
            } catch {
              return null; // the API is not listening yet
            }
          },
          { intervalMs: 50 }
        ),
        READY_TIMEOUT_MS,
        `the API did not start\n${child.output}`
      );
      assert.equal(created.state, 'queued');

      const { code, signal: killedBy } = await child.stop(signal);
      assert.equal(killedBy, null, `the API should exit through its handler, not via ${signal}`);
      assert.equal(code, 0);

      // The database was closed cleanly: reopen the very same file and find
      // the job, its key and its idempotent replay.
      const db = openDatabase(tmp.dbPath);
      try {
        const repo = createRepo(db);
        const job = repo.getJob(created.id);
        assert.ok(job, 'the created job should be on disk after the shutdown');
        assert.equal(job.state, 'queued');
        assert.equal(job.text, 'persist me');
        assert.equal(job.idempotencyKey, 'api-restart-key');

        const replay = repo.createJob({ text: 'persist me', idempotencyKey: 'api-restart-key' });
        assert.equal(replay.reused, true);
        assert.equal(replay.job.id, created.id);
      } finally {
        closeDatabase(db);
      }
    } finally {
      await child.kill();
      tmp.cleanup();
    }
  });
}
