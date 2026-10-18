import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createApiFixture,
  postJob,
  getJob,
  startWorker,
  runWorkerOnce,
} from './helpers.js';

test('a permanently failing job is retried exactly 3 times, then fails with the error preserved', async () => {
  const fixture = await createApiFixture();
  try {
    const { app, db, clock } = fixture;

    const created = await postJob(app, { text: 'one two three' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    const before = await getJob(app, id);
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().state, 'queued');
    assert.equal(before.json().attempts, 0);

    let calls = 0;
    const processJob = async () => {
      calls += 1;
      throw new Error('boom');
    };

    // Drive the worker until the job reaches a terminal state. Each tick
    // claims the job, runs the failing handler, and failJob requeues it
    // (attempts < maxAttempts) until the budget is exhausted.
    await runWorkerOnce({
      db,
      now: clock,
      leaseMs: 10_000,
      maxAttempts: 3,
      processJob,
      maxTicks: 200,
    });

    assert.equal(calls, 3, 'handler should be invoked exactly 3 times');

    const after = await getJob(app, id);
    assert.equal(after.statusCode, 200);
    const body = after.json();
    assert.equal(body.state, 'failed');
    assert.equal(body.attempts, 3);
    assert.equal(body.result, null);
    assert.equal(body.error, 'boom');

    // Sanity: the row in the DB agrees with the API view.
    const row = db
      .prepare('SELECT state, attempts, error, result FROM jobs WHERE id = ?')
      .get(id);
    assert.equal(row.state, 'failed');
    assert.equal(row.attempts, 3);
    assert.equal(row.error, 'boom');
    assert.equal(row.result, null);
  } finally {
    await fixture.cleanup();
  }
});

test('lease expiry on the third attempt moves the job to failed with LEASE_EXPIRED and no fourth claim', async () => {
  const fixture = await createApiFixture();
  try {
    const { app, db, clock } = fixture;

    const created = await postJob(app, { text: 'alpha beta gamma' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    const leaseMs = 10_000;
    const maxAttempts = 3;

    // Attempts 1 and 2: the handler fails immediately, so failJob requeues
    // the job (attempts < maxAttempts) and the worker keeps going.
    let calls = 0;
    const failingHandler = async () => {
      calls += 1;
      throw new Error('transient');
    };

    await runWorkerOnce({
      db,
      now: clock,
      leaseMs,
      maxAttempts,
      processJob: failingHandler,
      maxTicks: 200,
    });

    // After two failures the job is back in `queued` with attempts=2.
    const midway = await getJob(app, id);
    assert.equal(midway.statusCode, 200);
    assert.equal(midway.json().state, 'queued');
    assert.equal(midway.json().attempts, 2);
    assert.equal(calls, 2);

    // Third attempt: the handler blocks forever (simulating a crash after
    // claim but before completion). We start the worker, wait until it has
    // claimed the job, then advance the clock past the lease and stop the
    // worker so the lease can expire.
    let claimed = false;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const worker = startWorker({
      db,
      now: clock,
      leaseMs,
      maxAttempts,
      processJob: async () => {
        claimed = true;
        await gate;
        return 0;
      },
    });

    // Wait until the worker has claimed the third attempt.
    while (!claimed) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Confirm the third attempt is in-flight: state=running, attempts=3.
    const running = await getJob(app, id);
    assert.equal(running.statusCode, 200);
    assert.equal(running.json().state, 'running');
    assert.equal(running.json().attempts, 3);

    // Advance the clock past the lease so the running job's lease expires.
    clock.advance(leaseMs + 1);

    // Stop the worker; the blocked handler will never complete, so the row
    // stays `running` with an expired lease.
    worker.stop();
    release();
    await worker.promise;

    // Now run a fresh worker tick: expireLeases should move the running job
    // with an expired lease and attempts >= maxAttempts to `failed` with
    // error='LEASE_EXPIRED'. claimJob must NOT pick it up again.
    let fourthClaim = false;
    await runWorkerOnce({
      db,
      now: clock,
      leaseMs,
      maxAttempts,
      processJob: async () => {
        fourthClaim = true;
        return 0;
      },
      maxTicks: 200,
    });

    assert.equal(fourthClaim, false, 'job must not be claimed a fourth time');

    const after = await getJob(app, id);
    assert.equal(after.statusCode, 200);
    const body = after.json();
    assert.equal(body.state, 'failed');
    assert.equal(body.attempts, 3);
    assert.equal(body.result, null);
    assert.equal(body.error, 'LEASE_EXPIRED');

    // Sanity: the DB row agrees.
    const row = db
      .prepare('SELECT state, attempts, error, result FROM jobs WHERE id = ?')
      .get(id);
    assert.equal(row.state, 'failed');
    assert.equal(row.attempts, 3);
    assert.equal(row.error, 'LEASE_EXPIRED');
    assert.equal(row.result, null);
  } finally {
    await fixture.cleanup();
  }
});
