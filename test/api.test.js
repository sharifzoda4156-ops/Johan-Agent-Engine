import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, closeDatabase } from '../src/db.js';
import { createTempDb, startApi, stopApi } from './helpers.js';

/**
 * Spin up a real file-backed SQLite database plus the Fastify API on an
 * ephemeral port, run `fn`, then tear everything down. Using a real file (not
 * ':memory:') keeps WAL/lease behaviour identical to production.
 *
 * @param {(ctx: { app: object, repo: object, baseUrl: string, db: object }) => Promise<void>} fn
 */
async function withApi(fn) {
  const tmp = createTempDb();
  const db = openDatabase(tmp.dbPath);
  const { app, repo, baseUrl } = await startApi(db);
  try {
    await fn({ app, repo, baseUrl, db });
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

test('POST /jobs creates a queued job with 201 and a Location header', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await call(baseUrl, 'POST', '/jobs', { body: { text: 'hello world' } });

    assert.equal(res.status, 201);
    assert.equal(res.headers.get('location'), `/jobs/${res.body.id}`);
    assert.equal(res.body.state, 'queued');
    assert.equal(res.body.result, null);
    assert.equal(res.body.attempts, 0);
    assert.equal(res.body.error, null);
  });
});

test('POST /jobs with the same key and text returns 200 and the same id', async () => {
  await withApi(async ({ baseUrl }) => {
    const first = await call(baseUrl, 'POST', '/jobs', {
      body: { text: 'same text' },
      headers: { 'idempotency-key': 'key-1' },
    });
    assert.equal(first.status, 201);

    const second = await call(baseUrl, 'POST', '/jobs', {
      body: { text: 'same text' },
      headers: { 'idempotency-key': 'key-1' },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
  });
});

test('POST /jobs with the same key but different text returns 409 IDEMPOTENCY_CONFLICT', async () => {
  await withApi(async ({ baseUrl }) => {
    await call(baseUrl, 'POST', '/jobs', {
      body: { text: 'first' },
      headers: { 'idempotency-key': 'key-2' },
    });

    const res = await call(baseUrl, 'POST', '/jobs', {
      body: { text: 'second' },
      headers: { 'idempotency-key': 'key-2' },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });
});

test('GET /jobs/:id returns 200 with the job object', async () => {
  await withApi(async ({ baseUrl }) => {
    const created = await call(baseUrl, 'POST', '/jobs', { body: { text: 'fetch me' } });

    const res = await call(baseUrl, 'GET', `/jobs/${created.body.id}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.body.id);
    assert.equal(res.body.state, 'queued');
    assert.equal(res.body.result, null);
    assert.equal(res.body.attempts, 0);
    assert.equal(res.body.error, null);
  });
});

test('POST /jobs/:id/cancel on a queued job returns 200 with state cancelled', async () => {
  await withApi(async ({ baseUrl }) => {
    const created = await call(baseUrl, 'POST', '/jobs', { body: { text: 'cancel me' } });

    const res = await call(baseUrl, 'POST', `/jobs/${created.body.id}/cancel`);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.body.id);
    assert.equal(res.body.state, 'cancelled');
  });
});

test('POST /jobs/:id/cancel on an already cancelled job returns 200 with the same object', async () => {
  await withApi(async ({ baseUrl }) => {
    const created = await call(baseUrl, 'POST', '/jobs', { body: { text: 'cancel twice' } });

    const first = await call(baseUrl, 'POST', `/jobs/${created.body.id}/cancel`);
    const second = await call(baseUrl, 'POST', `/jobs/${created.body.id}/cancel`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
  });
});

test('POST /jobs/:id/cancel on a running job returns 409 JOB_ALREADY_STARTED', async () => {
  await withApi(async ({ baseUrl, repo }) => {
    const created = await call(baseUrl, 'POST', '/jobs', { body: { text: 'running' } });

    const claimed = repo.claimNext();
    assert.ok(claimed, 'expected the job to be claimed');
    assert.equal(claimed.id, created.body.id);

    const res = await call(baseUrl, 'POST', `/jobs/${created.body.id}/cancel`);

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JOB_ALREADY_STARTED');
  });
});

test('POST /jobs/:id/cancel on a completed job returns 409 JOB_TERMINAL', async () => {
  await withApi(async ({ baseUrl, repo }) => {
    const created = await call(baseUrl, 'POST', '/jobs', { body: { text: 'done' } });

    const claimed = repo.claimNext();
    assert.ok(claimed, 'expected the job to be claimed');
    const ok = repo.completeJob(claimed.id, claimed.claimToken, 1);
    assert.equal(ok, true);

    const res = await call(baseUrl, 'POST', `/jobs/${created.body.id}/cancel`);

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JOB_TERMINAL');
  });
});

test('GET /jobs/:id with an unknown UUID returns 404 NOT_FOUND', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await call(baseUrl, 'GET', '/jobs/00000000-0000-4000-8000-000000000000');

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

test('POST /jobs/:id/cancel with an unknown UUID returns 404 NOT_FOUND', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await call(baseUrl, 'POST', '/jobs/00000000-0000-4000-8000-000000000000/cancel');

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

test('GET /jobs/:id with an invalid UUID returns 400 VALIDATION_ERROR', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await call(baseUrl, 'GET', '/jobs/not-a-uuid');

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

test('POST /jobs/:id/cancel with an invalid UUID returns 400 VALIDATION_ERROR', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await call(baseUrl, 'POST', '/jobs/not-a-uuid/cancel');

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

test('POST /jobs with an invalid body returns 400 VALIDATION_ERROR', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await call(baseUrl, 'POST', '/jobs', { body: { text: 123 } });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

test('POST /jobs with a non-object body returns 400 VALIDATION_ERROR', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await call(baseUrl, 'POST', '/jobs', { body: 'just a string' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

test('POST /jobs with the wrong Content-Type returns 415', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await fetch(baseUrl + '/jobs', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });

    assert.equal(res.status, 415);
  });
});

test('POST /jobs with a body over the limit returns 413', async () => {
  await withApi(async ({ baseUrl }) => {
    const big = 'a'.repeat(70000);
    const res = await fetch(baseUrl + '/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: big }),
    });

    assert.equal(res.status, 413);
  });
});

test('POST /jobs with an invalid Idempotency-Key returns 400 VALIDATION_ERROR', async () => {
  await withApi(async ({ baseUrl }) => {
    const res = await call(baseUrl, 'POST', '/jobs', {
      body: { text: 'valid text' },
      headers: { 'idempotency-key': 'bad key!' },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});
