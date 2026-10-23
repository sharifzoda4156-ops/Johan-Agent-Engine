import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, closeDatabase } from '../src/db.js';
import { createRepo } from '../src/repo.js';
import { createWorker } from '../src/worker.js';
import { createTempDb, makeClock, startApi, stopApi } from './helpers.js';

/**
 * Open a real file-backed SQLite database plus a repository and a controllable
 * clock, run `fn`, then tear everything down. No HTTP server is started, so
 * these tests exercise the worker/repo contract directly.
 *
 * @param {(ctx: { db: object, repo: object, clock: ReturnType<typeof makeClock> }) => Promise<void>} fn
 */
async function withRepo(fn) {
  const tmp = createTempDb();
  const db = openDatabase(tmp.dbPath);
  const repo = createRepo(db);
  const clock = makeClock(1_000_000);
  try {
    await fn({ db, repo, clock });
  } finally {
    closeDatabase(db);
    tmp.cleanup();
  }
}

/**
 * Same as {@link withRepo} but also boots the Fastify API on an ephemeral port
 * so a job can be created through the real HTTP surface.
 *
 * @param {(ctx: { app: object, repo: object, baseUrl: string, db: object, clock: ReturnType<typeof makeClock> }) => Promise<void>} fn
 */
async function withApi(fn) {
  const tmp = createTempDb();
  const db = openDatabase(tmp.dbPath);
  const { app, repo, baseUrl } = await startApi(db);
  const clock = makeClock(1_000_000);
  try {
    await fn({ app, repo, baseUrl, db, clock });
  } finally {
    await stopApi(app);
    closeDatabase(db);
    tmp.cleanup();
  }
}

/**
 * Minimal fetch wrapper that JSON-encodes the body and parses the response.
 *
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, headers?: Record<string, string> }} [opts]
 */
async function call(baseUrl, method, path, { body, headers } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? JSON.parse(text) : null,
  };
}

test('POST /jobs -> worker -> completed exposes wordCount and attempts=1', async () => {
  await withApi(async ({ baseUrl, repo, clock }) => {
    const created = await call(baseUrl, 'POST', '/jobs', {
      body: { text: 'hello brave new world' },
    });
    assert.equal(created.status, 201);

    const worker = createWorker({ repo, now: clock });
    assert.equal(await worker.runOnce(), true);

    const res = await call(baseUrl, 'GET', `/jobs/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'completed');
    assert.deepEqual(res.body.result, { wordCount: 4 });
    assert.equal(res.body.attempts, 1);
    assert.equal(res.body.error, null);
  });
});

test('a crash after claim is recovered once the lease expires and stores the right result', async () => {
  await withRepo(async ({ repo, clock }) => {
    const { job } = repo.createJob({ text: 'one two three' });

    // Simulate a worker that claimed the job and then died before writing.
    const crashed = repo.claimNext(clock());
    assert.ok(crashed, 'the first claim should succeed');
    assert.equal(crashed.id, job.id);
    assert.equal(crashed.attempts, 1);

    // While the lease is live the job cannot be claimed again.
    const idle = createWorker({ repo, now: clock });
    assert.equal(await idle.runOnce(), false);

    // Move past the 10s lease so the job becomes claimable again.
    clock.advance(10_001);

    const worker = createWorker({ repo, now: clock });
    assert.equal(await worker.runOnce(), true);

    const stored = repo.getJob(job.id);
    assert.equal(stored.state, 'completed');
    assert.equal(stored.result, 3);
    assert.equal(stored.attempts, 2);
  });
});

test('a stale claim_token cannot overwrite the current owner result', async () => {
  await withRepo(async ({ repo, clock }) => {
    const { job } = repo.createJob({ text: 'stale writer' });

    const first = repo.claimNext(clock());
    assert.ok(first, 'the first claim should succeed');
    clock.advance(10_001);

    const second = repo.claimNext(clock());
    assert.ok(second, 'the job should be re-claimable after the lease expired');
    assert.equal(second.attempts, 2);
    assert.notEqual(second.claimToken, first.claimToken);

    // The stale worker (token A) is rejected for both completion and failure.
    assert.equal(repo.completeJob(first.id, first.claimToken, 111, clock()), false);
    assert.equal(repo.failJob(first.id, first.claimToken, 'stale', clock()), false);

    // The current owner (token B) writes the real result.
    assert.equal(repo.completeJob(second.id, second.claimToken, 2, clock()), true);

    const stored = repo.getJob(job.id);
    assert.equal(stored.state, 'completed');
    assert.equal(stored.result, 2);
    assert.equal(stored.attempts, 2);
  });
});

test('a permanently failing job is retried exactly 3 times and ends failed with the last error', async () => {
  await withRepo(async ({ repo, clock }) => {
    const { job } = repo.createJob({ text: 'always fails' });

    let calls = 0;
    const failing = () => {
      calls += 1;
      throw new Error(`boom ${calls}`);
    };

    const worker = createWorker({ repo, now: clock, processJob: failing });

    // Attempt 1: claim -> fail -> requeued.
    assert.equal(await worker.runOnce(), true);
    assert.equal(repo.getJob(job.id).state, 'queued');
    assert.equal(repo.getJob(job.id).attempts, 1);

    // Attempt 2: claim -> fail -> requeued.
    assert.equal(await worker.runOnce(), true);
    assert.equal(repo.getJob(job.id).state, 'queued');
    assert.equal(repo.getJob(job.id).attempts, 2);

    // Attempt 3: claim -> fail -> terminal.
    assert.equal(await worker.runOnce(), true);
    const final = repo.getJob(job.id);
    assert.equal(final.state, 'failed');
    assert.equal(final.attempts, 3);
    assert.equal(final.error, 'boom 3');

    // No fourth attempt: nothing left to claim.
    assert.equal(await worker.runOnce(), false);
    assert.equal(calls, 3);
  });
});

test('an expired lease on the third attempt fails the job with LEASE_EXPIRED and no fourth claim', async () => {
  await withRepo(async ({ repo, clock }) => {
    const { job } = repo.createJob({ text: 'never finishes' });

    // Three claims, each abandoned (the worker crashed before writing a result).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = repo.claimNext(clock());
      assert.ok(claimed, `claim ${attempt} should succeed`);
      assert.equal(claimed.attempts, attempt);
      clock.advance(10_001);
    }

    // A worker tick expires the third lease and finds nothing left to claim.
    const worker = createWorker({ repo, now: clock });
    assert.equal(await worker.runOnce(), false);

    const stored = repo.getJob(job.id);
    assert.equal(stored.state, 'failed');
    assert.equal(stored.error, 'LEASE_EXPIRED');
    assert.equal(stored.attempts, 3);

    // No fourth claim is possible.
    assert.equal(repo.claimNext(clock()), null);
  });
});

test('a cancel/claim race resolves to exactly one outcome', async () => {
  await withRepo(async ({ repo, clock }) => {
    // Case A: the claim wins — cancel is rejected and the job runs.
    const a = repo.createJob({ text: 'claim wins' }).job;
    const claimed = repo.claimNext(clock());
    assert.ok(claimed, 'the claim should win');
    assert.equal(claimed.id, a.id);
    assert.throws(
      () => repo.cancelJob(a.id),
      (err) => err.code === 'JOB_ALREADY_STARTED'
    );
    assert.equal(repo.getJob(a.id).state, 'running');

    // Case B: the cancel wins — the job is never claimed.
    const b = repo.createJob({ text: 'cancel wins' }).job;
    const cancelled = repo.cancelJob(b.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(repo.claimNext(clock()), null);
    assert.equal(repo.getJob(b.id).state, 'cancelled');
  });
});

test('cancelling a queued job through the API excludes it from execution', async () => {
  await withApi(async ({ baseUrl, repo, clock }) => {
    const created = await call(baseUrl, 'POST', '/jobs', { body: { text: 'do not run' } });

    const cancelled = await call(baseUrl, 'POST', `/jobs/${created.body.id}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.state, 'cancelled');

    const worker = createWorker({ repo, now: clock });
    assert.equal(await worker.runOnce(), false);

    const res = await call(baseUrl, 'GET', `/jobs/${created.body.id}`);
    assert.equal(res.body.state, 'cancelled');
    assert.equal(res.body.result, null);
    assert.equal(res.body.attempts, 0);
  });
});
