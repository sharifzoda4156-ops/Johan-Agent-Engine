import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createApiFixture,
  postJob,
  getJob,
  runWorkerOnce,
} from './helpers.js';

test('happy path: POST /jobs -> worker claims -> completed with correct wordCount and attempts=1', async () => {
  const fixture = await createApiFixture();
  const { app, db, clock } = fixture;

  try {
    // 1. Create a job via the API.
    const text = 'Hello world from the background worker';
    const createRes = await postJob(app, { text });

    assert.equal(createRes.statusCode, 201);
    const created = createRes.json();
    assert.equal(created.state, 'queued');
    assert.equal(created.attempts, 0);
    assert.equal(created.result, null);
    assert.equal(created.error, null);
    assert.ok(created.id, 'created job should have an id');
    assert.equal(createRes.headers.location, `/jobs/${created.id}`);

    // 2. Run the worker until the queue is drained.
    await runWorkerOnce({
      db,
      now: clock,
      leaseMs: 10_000,
      maxAttempts: 3,
    });

    // 3. The job should now be completed with the correct word count.
    const getRes = await getJob(app, created.id);
    assert.equal(getRes.statusCode, 200);

    const job = getRes.json();
    assert.equal(job.id, created.id);
    assert.equal(job.state, 'completed');
    assert.equal(job.attempts, 1);
    assert.equal(job.error, null);
    assert.deepEqual(job.result, { wordCount: 6 });
  } finally {
    await fixture.cleanup();
  }
});
