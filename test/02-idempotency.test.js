import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiFixture, postJob } from './helpers.js';

test('idempotency: identical key+text returns the same job id', async (t) => {
  const fixture = await createApiFixture();
  t.after(fixture.cleanup);

  const { app } = fixture;
  const key = 'idem-key-1';
  const body = { text: 'hello world' };

  const first = await postJob(app, body, { idempotencyKey: key });
  assert.equal(first.statusCode, 201);
  const firstBody = first.json();
  assert.ok(firstBody.id, 'first response should include an id');
  assert.equal(firstBody.state, 'queued');
  assert.equal(firstBody.attempts, 0);
  assert.equal(first.headers.location, `/jobs/${firstBody.id}`);

  const second = await postJob(app, body, { idempotencyKey: key });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json();
  assert.equal(secondBody.id, firstBody.id, 'same key+text must reuse the job id');
  assert.equal(secondBody.state, 'queued');
  assert.equal(secondBody.attempts, 0);

  // Only one row should exist for this key.
  const rows = fixture.db
    .prepare('SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = ?')
    .get(key);
  assert.equal(rows.n, 1);
});

test('idempotency: same key with different text returns 409 IDEMPOTENCY_CONFLICT', async (t) => {
  const fixture = await createApiFixture();
  t.after(fixture.cleanup);

  const { app } = fixture;
  const key = 'idem-key-2';

  const first = await postJob(app, { text: 'first text' }, { idempotencyKey: key });
  assert.equal(first.statusCode, 201);
  const firstId = first.json().id;

  const conflict = await postJob(app, { text: 'different text' }, { idempotencyKey: key });
  assert.equal(conflict.statusCode, 409);
  const conflictBody = conflict.json();
  assert.equal(conflictBody.error.code, 'IDEMPOTENCY_CONFLICT');

  // The original job must be untouched and still the only row for this key.
  const rows = fixture.db
    .prepare('SELECT id, text FROM jobs WHERE idempotency_key = ?')
    .all(key);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, firstId);
  assert.equal(rows[0].text, 'first text');
});

test('idempotency: concurrent creations with the same key do not duplicate the job', async (t) => {
  const fixture = await createApiFixture();
  t.after(fixture.cleanup);

  const { app } = fixture;
  const key = 'idem-key-concurrent';
  const body = { text: 'concurrent text' };

  const responses = await Promise.all(
    Array.from({ length: 8 }, () => postJob(app, body, { idempotencyKey: key }))
  );

  // Every response must be a success (201 for the winner, 200 for the rest)
  // and must reference the same job id.
  const ids = new Set();
  for (const res of responses) {
    assert.ok(
      res.statusCode === 201 || res.statusCode === 200,
      `unexpected status ${res.statusCode}: ${res.body}`
    );
    ids.add(res.json().id);
  }
  assert.equal(ids.size, 1, 'all concurrent responses must share one job id');

  // Exactly one row must exist for this key.
  const rows = fixture.db
    .prepare('SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = ?')
    .get(key);
  assert.equal(rows.n, 1, 'concurrent creations must not duplicate the job');
});
