import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from '../webhooks.js';

test('roundtrip', () => {
  const { body, header } = sign({ event: 'paid', id: 7 }, 's3cret', 1_700_000_000);
  assert.deepEqual(verify(body, header, 's3cret', { now: 1_700_000_010 }), { event: 'paid', id: 7 });
});

test('wrong secret', () => {
  const { body, header } = sign({ a: 1 }, 's3cret', 1_700_000_000);
  assert.throws(() => verify(body, header, 'other', { now: 1_700_000_000 }), { code: 'BAD_SIGNATURE' });
});

test('stale', () => {
  const { body, header } = sign({ a: 1 }, 's3cret', 1_700_000_000);
  assert.throws(() => verify(body, header, 's3cret', { now: 1_700_000_301 }), { code: 'STALE' });
});
