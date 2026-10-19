import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createWorker } from '../src/worker.js';
import { createJobStore } from '../src/jobs.js';
import { openDb } from '../src/db.js';
import { setup, post, deferred } from './helpers.js';

const cancel = (app, id) => app.inject({ method: 'POST', url: `/jobs/${id}/cancel` });

test('3. отмена queued исключает выполнение; повторная отмена — 200', async () => {
  const { db, clock } = setup();
  const app = buildApp({ db, now: clock.now });
  const { id } = (await post(app, 'a b')).json();
  const r1 = await cancel(app, id);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.json().state, 'cancelled');
  const r2 = await cancel(app, id);
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.json(), r1.json());
  let calls = 0;
  const worker = createWorker({ db, now: clock.now, process: () => { calls++; return 0; } });
  assert.equal(await worker.runOnce(), null);
  clock.advance(60_000);
  assert.equal(await worker.runOnce(), null);
  assert.equal(calls, 0);
  assert.equal((await app.inject({ method: 'GET', url: `/jobs/${id}` })).json().state, 'cancelled');
  await app.close();
  db.close();
});

test('3. отмена running → 409 JOB_ALREADY_STARTED; completed/failed → 409 JOB_TERMINAL', async () => {
  const { db, clock } = setup();
  const app = buildApp({ db, now: clock.now });
  const gate = deferred();
  const worker = createWorker({ db, now: clock.now, process: () => gate.promise });
  const { id } = (await post(app, 'a')).json();
  const running = worker.runOnce();
  const r = await cancel(app, id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, 'JOB_ALREADY_STARTED');
  gate.resolve(1);
  assert.equal((await running).outcome, 'completed');
  const t = await cancel(app, id);
  assert.equal(t.statusCode, 409);
  assert.equal(t.json().error.code, 'JOB_TERMINAL');

  const failing = createWorker({ db, now: clock.now, process: () => { throw new Error('boom'); } });
  const { id: id2 } = (await post(app, 'b')).json();
  for (let i = 0; i < 3; i++) await failing.runOnce();
  assert.equal((await cancel(app, id2)).json().error.code, 'JOB_TERMINAL');
  await app.close();
  db.close();
});

test('3. управляемая гонка cancel/claim на двух соединениях: ровно один исход', async () => {
  const { db, file, clock } = setup();
  const apiDb = db;
  const workerDb = openDb(file);
  const api = createJobStore(apiDb, { now: clock.now });
  const wrk = createJobStore(workerDb, { now: clock.now });

  // Порядок A: claim раньше cancel.
  const a = api.create('x').row;
  const claimed = wrk.claim();
  assert.equal(claimed.id, a.id);
  assert.equal(api.cancel(a.id).error, 'JOB_ALREADY_STARTED');
  assert.equal(api.get(a.id).state, 'running');
  wrk.complete(claimed.id, claimed.claim_token, 1);

  // Порядок B: cancel раньше claim.
  const b = api.create('y').row;
  assert.equal(api.cancel(b.id).row.state, 'cancelled');
  assert.equal(wrk.claim(), null);
  assert.equal(api.get(b.id).state, 'cancelled');
  assert.equal(api.get(b.id).attempts, 0);

  // Конкурентно в одном цикле событий через API и worker (100 повторов).
  const app = buildApp({ db: apiDb, now: clock.now });
  const worker = createWorker({ db: workerDb, now: clock.now });
  for (let i = 0; i < 100; i++) {
    const { id } = (await post(app, 'z')).json();
    const [c, w] = await Promise.all([cancel(app, id), worker.runOnce()]);
    const row = api.get(id);
    if (c.statusCode === 200) {
      assert.equal(row.state, 'cancelled');
      assert.equal(w, null);
    } else {
      assert.equal(c.statusCode, 409);
      assert.equal(row.state, 'completed');
      assert.equal(w.job.id, id);
    }
  }
  await app.close();
  workerDb.close();
  apiDb.close();
});
