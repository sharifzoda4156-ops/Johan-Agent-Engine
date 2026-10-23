import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

async function start(items) {
  const server = createServer({ items });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { get, close };
}

function makeItems(count) {
  return Array.from({ length: count }, (_, n) => ({
    id: `item-${String(n).padStart(3, '0')}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  }));
}

test('GET /items returns 200 with items sorted newest first', async () => {
  const items = makeItems(5);
  const { get, close } = await start(items);
  try {
    const res = await get('/items');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((i) => i.id),
      ['item-004', 'item-003', 'item-002', 'item-001', 'item-000'],
    );
    assert.equal(res.body.nextCursor, null);
  } finally {
    await close();
  }
});

test('GET /items paginates via limit and cursor without gaps or duplicates', async () => {
  const items = makeItems(5);
  const { get, close } = await start(items);
  try {
    const seen = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const path = cursor ? `/items?limit=2&cursor=${encodeURIComponent(cursor)}` : '/items?limit=2';
      const res = await get(path);
      assert.equal(res.status, 200);
      assert.ok(res.body.items.length <= 2);
      seen.push(...res.body.items.map((i) => i.id));
      if (res.body.nextCursor === null) break;
      cursor = res.body.nextCursor;
    }
    assert.deepEqual(seen, ['item-004', 'item-003', 'item-002', 'item-001', 'item-000']);
  } finally {
    await close();
  }
});

test('GET /items returns 400 INVALID_LIMIT for invalid limit values', async () => {
  const items = makeItems(3);
  const { get, close } = await start(items);
  try {
    const bad = ['500', 'abc', '0', '1.5', '-1', '10abc', ''];
    for (const value of bad) {
      const res = await get(`/items?limit=${encodeURIComponent(value)}`);
      assert.equal(res.status, 400, `expected 400 for limit=${JSON.stringify(value)}`);
      assert.equal(res.body.error.code, 'INVALID_LIMIT');
    }
  } finally {
    await close();
  }
});

test('GET /items returns 400 INVALID_CURSOR for a malformed cursor', async () => {
  const items = makeItems(3);
  const { get, close } = await start(items);
  try {
    for (const cursor of ['not-a-cursor', 'eyJjIjo', 'x', '']) {
      const res = await get(`/items?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(res.status, 400, `expected 400 for cursor=${JSON.stringify(cursor)}`);
      assert.equal(res.body.error.code, 'INVALID_CURSOR');
    }
  } finally {
    await close();
  }
});
