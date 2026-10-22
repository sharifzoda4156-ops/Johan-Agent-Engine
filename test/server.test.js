import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

function makeStore(items) {
  return { all: () => items };
}

async function start(items) {
  const server = createServer(makeStore(items));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (path) => {
    const res = await fetch(base + path);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { call, close };
}

function makeItems(n) {
  const items = [];
  for (let i = 0; i < n; i += 1) {
    items.push({
      id: String.fromCharCode(97 + i),
      createdAt: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    });
  }
  return items;
}

test('GET /items returns 200 with { items, nextCursor } shape', async () => {
  const { call, close } = await start(makeItems(3));
  try {
    const res = await call('/items');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 3);
    assert.ok('nextCursor' in res.body);
    assert.equal(res.body.nextCursor, null);
  } finally {
    await close();
  }
});

test('GET /items rejects invalid limit with 400 INVALID_LIMIT', async () => {
  const { call, close } = await start(makeItems(3));
  try {
    for (const raw of ['500', 'abc', '0', '1.5', '-1', '10abc', '']) {
      const res = await call(`/items?limit=${encodeURIComponent(raw)}`);
      assert.equal(res.status, 400, `limit=${raw} should be 400`);
      assert.equal(res.body.error.code, 'INVALID_LIMIT', `limit=${raw} code`);
    }
  } finally {
    await close();
  }
});

test('GET /items rejects broken cursor with 400 INVALID_CURSOR', async () => {
  const { call, close } = await start(makeItems(3));
  try {
    for (const raw of ['not-a-cursor', 'AAAA', 'e30', 'bnVsbA']) {
      const res = await call(`/items?cursor=${encodeURIComponent(raw)}`);
      assert.equal(res.status, 400, `cursor=${raw} should be 400`);
      assert.equal(res.body.error.code, 'INVALID_CURSOR', `cursor=${raw} code`);
    }
  } finally {
    await close();
  }
});

test('GET /items paginates across pages using nextCursor', async () => {
  const { call, close } = await start(makeItems(4));
  try {
    const first = await call('/items?limit=2');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.items.map((i) => i.id), ['d', 'c']);
    assert.ok(first.body.nextCursor);

    const second = await call(
      `/items?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.items.map((i) => i.id), ['b', 'a']);
    assert.equal(second.body.nextCursor, null);
  } finally {
    await close();
  }
});

test('GET /items returns 404 for unknown routes', async () => {
  const { call, close } = await start(makeItems(1));
  try {
    const res = await call('/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  } finally {
    await close();
  }
});
