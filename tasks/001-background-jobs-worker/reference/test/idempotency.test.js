import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { buildApp } from '../src/app.js';
import { setup, post } from './helpers.js';

test('2. тот же ключ+текст → тот же ID (200); другой текст → 409', async () => {
  const { db, clock } = setup();
  const app = buildApp({ db, now: clock.now });
  const a = await post(app, 'Hello world', 'k-1');
  assert.equal(a.statusCode, 201);
  const b = await post(app, 'Hello world', 'k-1');
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().id, a.json().id);
  assert.equal(b.headers.location, undefined);
  const c = await post(app, 'Hello world!', 'k-1');
  assert.equal(c.statusCode, 409);
  assert.equal(c.json().error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n, 1);
  await app.close();
  db.close();
});

test('2. одновременные создания из разных соединений/потоков не дублируют задание', async () => {
  const { db, file } = setup();
  const THREADS = 6;
  const PER = 25;
  const src = `
    import { workerData, parentPort } from 'node:worker_threads';
    const { openDb } = await import(workerData.dbUrl);
    const { createJobStore } = await import(workerData.jobsUrl);
    const db = openDb(workerData.file);
    const store = createJobStore(db);
    const sab = new Int32Array(workerData.sab);
    Atomics.add(sab, 0, 1);
    while (Atomics.load(sab, 0) < workerData.threads) {} // общий старт
    const out = [];
    for (let i = 0; i < workerData.per; i++) {
      const r = store.create('same text', 'race-key-' + i);
      out.push({ i, id: r.row.id, created: r.created });
    }
    db.close();
    parentPort.postMessage(out);
  `;
  const sab = new SharedArrayBuffer(4);
  const workerData = {
    file, sab, threads: THREADS, per: PER,
    dbUrl: new URL('../src/db.js', import.meta.url).href,
    jobsUrl: new URL('../src/jobs.js', import.meta.url).href,
  };
  const results = await Promise.all(Array.from({ length: THREADS }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(`data:text/javascript,${encodeURIComponent(src)}`), { workerData });
    w.once('message', resolve);
    w.once('error', reject);
  })));
  for (let i = 0; i < PER; i++) {
    const rows = results.map((r) => r[i]);
    assert.equal(new Set(rows.map((r) => r.id)).size, 1, `key ${i}: один ID`);
    assert.equal(rows.filter((r) => r.created).length, 1, `key ${i}: ровно одно создание`);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n, PER);
  db.close();
});
