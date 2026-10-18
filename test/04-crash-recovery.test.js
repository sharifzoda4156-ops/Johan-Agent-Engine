import test from 'node:test';
import assert from 'node:assert/strict';

import { claimJob, completeJob, getJob } from '../src/jobs.js';
import {
  createApiFixture,
  postJob,
  getJob as getJobViaApi,
  runWorkerOnce,
} from './helpers.js';

const LEASE_MS = 10_000;
const MAX_ATTEMPTS = 3;

test('worker crash after claim: lease expiry allows reclaim and correct result', async () => {
  const fixture = await createApiFixture();
  try {
    const { app, db, clock } = fixture;

    const created = await postJob(app, { text: 'one two three four five' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    // Simulate a worker that claims the job and then crashes before saving
    // the result: the row is left in `running` with a live lease.
    const claimed = claimJob(db, {
      now: clock(),
      leaseMs: LEASE_MS,
      maxAttempts: MAX_ATTEMPTS,
    });
    assert.ok(claimed, 'expected the job to be claimed');
    assert.equal(claimed.id, id);
    assert.equal(claimed.state, 'running');
    assert.equal(claimed.attempts, 1);
    assert.ok(claimed.claim_token);

    // The crashed worker never wrote a result.
    const afterCrash = getJob(db, id);
    assert.equal(afterCrash.state, 'running');
    assert.equal(afterCrash.result, null);
    assert.equal(afterCrash.error, null);

    // Advance the clock past the lease so the job becomes reclaimable.
    clock.advance(LEASE_MS + 1);

    // A fresh worker reclaims the job and completes it with the real result.
    await runWorkerOnce({
      db,
      now: clock,
      leaseMs: LEASE_MS,
      maxAttempts: MAX_ATTEMPTS,
    });

    const recovered = getJob(db, id);
    assert.equal(recovered.state, 'completed');
    assert.equal(recovered.result, 5);
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.error, null);

    // The API reflects the recovered result.
    const viaApi = await getJobViaApi(app, id);
    assert.equal(viaApi.statusCode, 200);
    const body = viaApi.json();
    assert.equal(body.state, 'completed');
    assert.deepEqual(body.result, { wordCount: 5 });
    assert.equal(body.attempts, 2);
    assert.equal(body.error, null);
  } finally {
    await fixture.cleanup();
  }
});

test('stale claim_token cannot overwrite the result after reclaim', async () => {
  const fixture = await createApiFixture();
  try {
    const { app, db, clock } = fixture;

    const created = await postJob(app, { text: 'alpha beta gamma' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    // First (crashed) worker claims the job.
    const first = claimJob(db, {
      now: clock(),
      leaseMs: LEASE_MS,
      maxAttempts: MAX_ATTEMPTS,
    });
    assert.ok(first);
    const staleToken = first.claim_token;
    assert.ok(staleToken);

    // Lease expires; a second worker reclaims and completes the job.
    clock.advance(LEASE_MS + 1);
    await runWorkerOnce({
      db,
      now: clock,
      leaseMs: LEASE_MS,
      maxAttempts: MAX_ATTEMPTS,
    });

    const completed = getJob(db, id);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.result, 3);
    assert.equal(completed.attempts, 2);

    // The stale worker now tries to write its (wrong) result using the old
    // claim token. It must be rejected and must not touch the row.
    const stale = completeJob(db, {
      id,
      claimToken: staleToken,
      result: 999,
      now: clock(),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.code, 'CLAIM_MISMATCH');

    const after = getJob(db, id);
    assert.equal(after.state, 'completed');
    assert.equal(after.result, 3);
    assert.equal(after.attempts, 2);
    assert.equal(after.error, null);
  } finally {
    await fixture.cleanup();
  }
});
