import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createWorker } from '../src/worker.js';
import { openDb } from '../src/db.js';
import { createJobStore } from '../src/jobs.js';
import { setup, post, fakeClock } from './helpers.js';

test('6. закрытие и повторное открытие файловой БД сохраняет задания, результаты, ошибки, ключи', async () => {
  const { db, file, clock } = setup();
  let app = buildApp({ db, now: clock.now });
  // Очередь FIFO по created_at: разводим время создания.
  const done = (await post(app, 'a b c', 'key-done')).json();
  clock.advance(1);
  const bad = (await post(app, 'bad', 'key-bad')).json();
  clock.advance(1);
  const queued = (await post(app, 'later', 'key-queued')).json();
  const cancelled = (await post(app, 'nope')).json();
  await app.inject({ method: 'POST', url: `/jobs/${cancelled.id}/cancel` });
  const w = createWorker({ db, now: clock.now, process: (t) => { if (t === 'bad') throw new Error('bad input'); return t.split(' ').length; } });
  await w.runOnce();
  for (let i = 0; i < 3; i++) await w.runOnce();
  // Worker захватил последнее задание и «упал» вместе с процессом.
  assert.equal(createJobStore(db, { now: clock.now }).claim().id, queued.id);
  await app.close();
  db.close();

  const db2 = openDb(file);
  assert.equal(db2.pragma('journal_mode', { simple: true }), 'wal');
  const clock2 = fakeClock(clock.t);
  app = buildApp({ db: db2, now: clock2.now });
  const get = async (id) => (await app.inject({ method: 'GET', url: `/jobs/${id}` })).json();
  assert.deepEqual(await get(done.id), { id: done.id, state: 'completed', result: { wordCount: 3 }, attempts: 1, error: null });
  assert.deepEqual(await get(bad.id), { id: bad.id, state: 'failed', result: null, attempts: 3, error: 'bad input' });
  assert.equal((await get(cancelled.id)).state, 'cancelled');
  assert.equal((await get(queued.id)).state, 'running');
  const again = await post(app, 'a b c', 'key-done');
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().id, done.id);
  assert.equal((await post(app, 'other', 'key-bad')).statusCode, 409);

  // Новый worker после рестарта подхватывает брошенное задание по истечении lease.
  const w2 = createWorker({ db: db2, now: clock2.now });
  assert.equal(await w2.runOnce(), null);
  clock2.advance(10_000);
  assert.equal((await w2.runOnce()).outcome, 'completed');
  assert.deepEqual(await get(queued.id), { id: queued.id, state: 'completed', result: { wordCount: 1 }, attempts: 2, error: null });
  await app.close();
  db2.close();
});
