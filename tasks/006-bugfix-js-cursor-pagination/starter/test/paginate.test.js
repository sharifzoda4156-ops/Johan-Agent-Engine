import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';

const items = Array.from({ length: 5 }, (_, n) => ({
  id: `id-${n}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
}));

test('first page is newest first', () => {
  const { items: page, nextCursor } = paginate([...items], { limit: 2 });
  assert.deepEqual(page.map((i) => i.id), ['id-4', 'id-3']);
  assert.ok(nextCursor);
});

test('cursor continues the feed', () => {
  const first = paginate([...items], { limit: 2 });
  const second = paginate([...items], { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((i) => i.id), ['id-2', 'id-1']);
});
