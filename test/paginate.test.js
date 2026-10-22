import test from 'node:test';
import assert from 'node:assert/strict';
import {
  paginate,
  parseLimit,
  encodeCursor,
  decodeCursor,
  DEFAULT_LIMIT,
  InvalidCursorError,
  InvalidLimitError,
} from '../src/paginate.js';

const items = [
  { id: 'a', createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'b', createdAt: '2024-01-02T00:00:00.000Z' },
  { id: 'c', createdAt: '2024-01-03T00:00:00.000Z' },
];

test('returns the first page in descending order', () => {
  const { items: page, nextCursor } = paginate(items, { limit: 2 });
  assert.deepEqual(page.map((i) => i.id), ['c', 'b']);
  assert.ok(nextCursor);
});

test('cursor returns the following page', () => {
  const first = paginate(items, { limit: 2 });
  const second = paginate(items, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((i) => i.id), ['a']);
  assert.equal(second.nextCursor, null);
});

test('parseLimit falls back to the default', () => {
  assert.equal(parseLimit(undefined), DEFAULT_LIMIT);
});

test('parseLimit rejects malformed and out-of-range limits', () => {
  for (const raw of ['500', 'abc', '0', '1.5', '-1', '10abc', '']) {
    assert.throws(() => parseLimit(raw), InvalidLimitError);
  }
});

test('parseLimit accepts the boundary values 1 and 100', () => {
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit('100'), 100);
});

test('paginate rejects invalid limits', () => {
  for (const limit of [500, 'abc', 0, 1.5, -1, '10abc', '']) {
    assert.throws(() => paginate(items, { limit }), InvalidLimitError);
  }
});

test('encodeCursor/decodeCursor round-trip', () => {
  const item = { id: 'x', createdAt: '2024-01-01T00:00:00.000Z' };
  assert.deepEqual(decodeCursor(encodeCursor(item)), { c: item.createdAt, i: item.id });
});

test('walks all items with equal createdAt exactly once in feed order', () => {
  const same = '2024-01-01T00:00:00.000Z';
  const batch = [
    { id: 'a', createdAt: same },
    { id: 'b', createdAt: same },
    { id: 'c', createdAt: same },
    { id: 'd', createdAt: same },
    { id: 'e', createdAt: same },
  ];

  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const { items: page, nextCursor } = paginate(batch, { limit: 2, cursor });
    seen.push(...page.map((i) => i.id));
    cursor = nextCursor;
    pages += 1;
    assert.ok(pages <= batch.length, 'pagination must terminate');
  } while (cursor != null);

  assert.deepEqual(seen, ['e', 'd', 'c', 'b', 'a']);
  assert.equal(new Set(seen).size, batch.length);
});

test('returns nextCursor=null on the last page when count is a multiple of limit', () => {
  const batch = [
    { id: 'd', createdAt: '2024-01-04T00:00:00.000Z' },
    { id: 'c', createdAt: '2024-01-03T00:00:00.000Z' },
    { id: 'b', createdAt: '2024-01-02T00:00:00.000Z' },
    { id: 'a', createdAt: '2024-01-01T00:00:00.000Z' },
  ];

  const first = paginate(batch, { limit: 2 });
  assert.deepEqual(first.items.map((i) => i.id), ['d', 'c']);
  assert.ok(first.nextCursor);

  const second = paginate(batch, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((i) => i.id), ['b', 'a']);
  assert.equal(second.nextCursor, null);
});

test('decodeCursor rejects broken, truncated, non-JSON and field-less cursors', () => {
  const valid = encodeCursor({ id: 'x', createdAt: '2024-01-01T00:00:00.000Z' });
  const b64 = (value) => Buffer.from(value, 'utf8').toString('base64url');

  const bad = [
    '',
    'not-a-cursor',
    valid.slice(0, Math.max(1, valid.length - 4)),
    b64('not json'),
    b64('{"c":'),
    b64('null'),
    b64('[]'),
    b64('123'),
    b64('"str"'),
    b64('{}'),
    b64('{"c":"2024-01-01T00:00:00.000Z"}'),
    b64('{"i":"x"}'),
    b64('{"c":1,"i":2}'),
    b64('{"c":null,"i":null}'),
  ];

  for (const cursor of bad) {
    assert.throws(() => decodeCursor(cursor), InvalidCursorError);
    assert.throws(() => paginate(items, { limit: 2, cursor }), InvalidCursorError);
  }
});

test('does not mutate the input array', () => {
  const input = [
    { id: 'a', createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'b', createdAt: '2024-01-02T00:00:00.000Z' },
    { id: 'c', createdAt: '2024-01-03T00:00:00.000Z' },
  ];
  const before = [...input];

  paginate(input, { limit: 2 });
  assert.deepEqual(input, before);

  const { nextCursor } = paginate(input, { limit: 2 });
  paginate(input, { limit: 2, cursor: nextCursor });
  assert.deepEqual(input, before);

  const same = '2024-01-01T00:00:00.000Z';
  const tied = [
    { id: 'c', createdAt: same },
    { id: 'a', createdAt: same },
    { id: 'b', createdAt: same },
  ];
  const tiedBefore = [...tied];
  paginate(tied, { limit: 2 });
  assert.deepEqual(tied, tiedBefore);
});
