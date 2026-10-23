import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  paginate,
  parseLimit,
  decodeCursor,
  InvalidCursorError,
  InvalidLimitError,
} from '../src/paginate.js';

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

// Report 1: many records share the same createdAt; paging by 2 must return each
// record exactly once, in feed order, with no gaps or duplicates.
test('paging with tied createdAt returns every item exactly once', () => {
  const same = new Date(Date.UTC(2026, 0, 1, 0, 0)).toISOString();
  const tied = Array.from({ length: 7 }, (_, n) => ({ id: `t-${n}`, createdAt: same }));

  const seen = [];
  let cursor;
  do {
    const page = paginate(tied, { limit: 2, cursor });
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
  } while (cursor);

  const expected = [...tied].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map((i) => i.id);
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, tied.length);
});

// Report 2: nextCursor is null exactly when nothing follows the page.
test('nextCursor is null only when no items remain', () => {
  const four = Array.from({ length: 4 }, (_, n) => ({
    id: `id-${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  }));

  const first = paginate(four, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor, 'first page must have a cursor');

  const second = paginate(four, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null, 'exact multiple: last page has no cursor');

  const single = paginate(four, { limit: 4 });
  assert.equal(single.items.length, 4);
  assert.equal(single.nextCursor, null, 'page covers everything: no cursor');
});

// Report 3: limit parsing.
test('parseLimit accepts the documented range', () => {
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit('100'), 100);
});

test('parseLimit rejects anything outside an integer 1..100', () => {
  for (const bad of ['0', '1.5', '-1', '10abc', '', '500', 'abc']) {
    assert.throws(() => parseLimit(bad), InvalidLimitError, `limit ${JSON.stringify(bad)}`);
  }
});

// Report 4: a corrupted cursor must be rejected, not silently accepted.
test('decodeCursor rejects truncated and garbage cursors', () => {
  const valid = Buffer.from(JSON.stringify({ c: 'x', i: 'y' })).toString('base64url');
  const truncated = valid.slice(0, Math.max(1, valid.length - 4));

  for (const bad of [truncated, 'not-a-cursor', '', 'eyJjIjoxfQ']) {
    assert.throws(() => decodeCursor(bad), InvalidCursorError, `cursor ${JSON.stringify(bad)}`);
    assert.throws(() => paginate([...items], { limit: 2, cursor: bad }), InvalidCursorError);
  }
});

// Report 5: paginate must not mutate the caller's array.
test('paginate does not mutate the input array', () => {
  const input = [...items];
  const snapshot = input.map((i) => i.id);

  paginate(input, { limit: 2 });
  assert.deepEqual(input.map((i) => i.id), snapshot, 'order preserved without cursor');

  const first = paginate(input, { limit: 2 });
  paginate(input, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(input.map((i) => i.id), snapshot, 'order preserved with cursor');
});
