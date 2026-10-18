import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker.js';
import { createJobStore, LEASE_MS } from '../src/jobs.js';
import { setup, deferred } from './helpers.js';

test('4. сбой после захвата → lease истёк → повторный захват → верный результат; устаревший token отклонён', async () => {
  const { db, clock } = setup();
  const store = createJobStore(db, { now: clock.now });
  const { id } = store.create('one two three').row;

  // Worker A захватил задание и «упал»: обработка не завершается.
  const hang = deferred();
  const a = createWorker({ db, now: clock.now, process: () => hang.promise });
  const aRun = a.runOnce();
  const first = store.get(id);
  assert.equal(first.state, 'running');
  assert.equal(first.attempts, 1);

  const b = createWorker({ db, now: clock.now });
  clock.advance(LEASE_MS - 1);
  assert.equal(await b.runOnce(), null, 'lease ещё действует');
  clock.advance(1);
  const bRun = await b.runOnce();
  assert.equal(bRun.outcome, 'completed');
  assert.notEqual(bRun.job.claim_token, first.claim_token);
  const done = store.get(id);
  assert.equal(done.state, 'completed');
  assert.equal(done.result, 3);
  assert.equal(done.attempts, 2);

  // A «ожил» и пытается записать свой результат по старому token.
  hang.resolve(999);
  assert.equal((await aRun).outcome, 'lease_lost');
  assert.equal(store.complete(id, first.claim_token, 999), null);
  assert.equal(store.fail(id, first.claim_token, 'late'), null);
  assert.equal(store.get(id).result, 3);
  db.close();
});

test('4. запись по своему token после истечения своего lease отклоняется', async () => {
  const { db, clock } = setup();
  const store = createJobStore(db, { now: clock.now });
  const { id } = store.create('a').row;
  const job = store.claim();
  clock.advance(LEASE_MS);
  assert.equal(store.complete(id, job.claim_token, 1), null);
  assert.equal(store.get(id).state, 'running');
  db.close();
});

test('5. постоянная ошибка → ровно 3 попытки, failed, причина сохранена', async () => {
  const { db, clock } = setup();
  const store = createJobStore(db, { now: clock.now });
  const { id } = store.create('a').row;
  let calls = 0;
  const w = createWorker({ db, now: clock.now, process: () => { calls++; throw new Error(`boom #${calls}`); } });
  assert.equal((await w.runOnce()).outcome, 'queued');
  assert.equal(store.get(id).error, 'boom #1');
  assert.equal((await w.runOnce()).outcome, 'queued');
  assert.equal((await w.runOnce()).outcome, 'failed');
  assert.equal(await w.runOnce(), null);
  clock.advance(LEASE_MS * 10);
  assert.equal(await w.runOnce(), null);
  const row = store.get(id);
  assert.equal(calls, 3);
  assert.deepEqual([row.state, row.attempts, row.error, row.claim_token, row.lease_until], ['failed', 3, 'boom #3', null, null]);
  db.close();
});

test('5. истечение lease третьей попытки → failed LEASE_EXPIRED без четвёртого захвата', async () => {
  const { db, clock } = setup();
  const store = createJobStore(db, { now: clock.now });
  const { id } = store.create('a').row;
  for (let i = 1; i <= 3; i++) {
    const job = store.claim();
    assert.equal(job.attempts, i);
    clock.advance(LEASE_MS);
  }
  let calls = 0;
  const w = createWorker({ db, now: clock.now, process: () => { calls++; return 1; } });
  assert.equal(await w.runOnce(), null);
  assert.equal(calls, 0);
  const row = store.get(id);
  assert.deepEqual([row.state, row.attempts, row.error], ['failed', 3, 'LEASE_EXPIRED']);
  db.close();
});
