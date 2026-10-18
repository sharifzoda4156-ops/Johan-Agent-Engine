import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelJob,
  createApiFixture,
  getJob,
  postJob,
  runWorkerOnce,
  startWorker,
} from './helpers.js';

test('cancelling a queued job prevents the worker from executing it', async () => {
  const fixture = await createApiFixture();
  try {
    const { app, db, clock } = fixture;

    // Create a job; it starts out queued.
    const created = await postJob(app, { text: 'one two three' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    const before = await getJob(app, id);
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().state, 'queued');
    assert.equal(before.json().attempts, 0);

    // Cancel it while still queued.
    const cancelled = await cancelJob(app, id);
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().state, 'cancelled');
    assert.equal(cancelled.json().result, null);

    // Run the worker; it must not pick up the cancelled job.
    let processed = 0;
    await runWorkerOnce({
      db,
      now: clock,
      leaseMs: 10_000,
      maxAttempts: 3,
      processJob: async () => {
        processed += 1;
        return 0;
      },
    });

    assert.equal(processed, 0, 'worker must not process a cancelled job');

    const after = await getJob(app, id);
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().state, 'cancelled');
    assert.equal(after.json().attempts, 0);
    assert.equal(after.json().result, null);
  } finally {
    await fixture.cleanup();
  }
});

test('cancel/claim race yields exactly one valid outcome', async () => {
  const fixture = await createApiFixture();
  try {
    const { app, db, clock } = fixture;

    const created = await postJob(app, { text: 'alpha beta gamma delta' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    // Start the worker with a handler that blocks until we release it, so we
    // can deterministically interleave the cancel with the claim.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let claimed = false;

    const worker = startWorker({
      db,
      now: clock,
      leaseMs: 10_000,
      maxAttempts: 3,
      processJob: async () => {
        claimed = true;
        await gate;
        return 4;
      },
    });

    // Give the worker a chance to claim the job. We poll the DB directly
    // (no long sleeps) until the job leaves the queued state or we give up.
    const deadline = Date.now() + 2_000;
    let row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    while (row.state === 'queued' && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    }

    // Now attempt to cancel. Depending on the interleaving, either:
    //  - the worker already claimed the job (state running/completed) and the
    //    cancel must fail with 409 JOB_ALREADY_STARTED, or
    //  - the job is still queued and the cancel succeeds (state cancelled).
    const cancelResponse = await cancelJob(app, id);

    if (row.state === 'queued') {
      // Cancel won the race.
      assert.equal(cancelResponse.statusCode, 200);
      assert.equal(cancelResponse.json().state, 'cancelled');

      // Release the worker (it should never have claimed the job).
      release();
      worker.stop();
      await worker.promise;

      assert.equal(claimed, false, 'worker must not have claimed a cancelled job');

      const final = await getJob(app, id);
      assert.equal(final.json().state, 'cancelled');
      assert.equal(final.json().attempts, 0);
      assert.equal(final.json().result, null);
    } else {
      // Worker won the race: cancel must be rejected.
      assert.equal(cancelResponse.statusCode, 409);
      assert.equal(cancelResponse.json().error.code, 'JOB_ALREADY_STARTED');

      // Let the worker finish processing.
      release();
      worker.stop();
      await worker.promise;

      assert.equal(claimed, true, 'worker must have claimed the job');

      const final = await getJob(app, id);
      assert.equal(final.json().state, 'completed');
      assert.equal(final.json().attempts, 1);
      assert.deepEqual(final.json().result, { wordCount: 4 });
    }
  } finally {
    await fixture.cleanup();
  }
});
