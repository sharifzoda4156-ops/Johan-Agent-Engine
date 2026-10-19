import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createWorker } from '../src/worker.js';
import { countWords } from '../src/countWords.js';
import { setup, post } from './helpers.js';

test('1. POST /jobs → реальный захват worker → completed, wordCount, attempts=1', async () => {
  const { db, clock } = setup();
  const app = buildApp({ db, now: clock.now });
  const res = await post(app, '  Hello   world\n\tfoo ');
  assert.equal(res.statusCode, 201);
  const job = res.json();
  assert.equal(res.headers.location, `/jobs/${job.id}`);
  assert.deepEqual(job, { id: job.id, state: 'queued', result: null, attempts: 0, error: null });

  const worker = createWorker({ db, now: clock.now });
  const run = await worker.runOnce();
  assert.equal(run.outcome, 'completed');

  const got = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
  assert.deepEqual(got, { id: job.id, state: 'completed', result: { wordCount: 3 }, attempts: 1, error: null });
  assert.equal(await worker.runOnce(), null);
  await app.close();
  db.close();
});

test('countWords: правила JS \\s', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords(' \n\t   '), 0);
  assert.equal(countWords('a b　c'), 3);
  assert.equal(countWords('привет, мир!'), 2);
  assert.equal(countWords('😀 😀'), 2);
});

test('валидация и коды ошибок', async () => {
  const { db, clock } = setup();
  const app = buildApp({ db, now: clock.now });
  const req = (payload, headers = { 'content-type': 'application/json' }) =>
    app.inject({ method: 'POST', url: '/jobs', headers, payload });
  const code = async (r) => { const x = await r; return [x.statusCode, x.json().error?.code]; };

  assert.equal((await post(app, '')).statusCode, 201, 'пустой текст допустим');
  assert.equal((await post(app, 'x'.repeat(10_000))).statusCode, 201);
  assert.deepEqual(await code(post(app, 'x'.repeat(10_001))), [400, 'VALIDATION_ERROR']);
  // 5000 эмодзи = 10 000 UTF-16 code units — на границе; ещё один — за ней.
  assert.equal((await post(app, '😀'.repeat(5000))).statusCode, 201);
  assert.deepEqual(await code(post(app, '😀'.repeat(5000) + 'a')), [400, 'VALIDATION_ERROR']);

  for (const bad of ['{}', '[]', 'null', '"x"', '{"text":1}', '{"text":null}', '{"text":"a","extra":1}', '{bad json']) {
    assert.deepEqual(await code(req(bad)), [400, 'VALIDATION_ERROR'], bad);
  }
  assert.deepEqual(await code(req('text=a', { 'content-type': 'text/plain' })), [415, 'UNSUPPORTED_MEDIA_TYPE']);
  assert.deepEqual(await code(req(JSON.stringify({ text: 'a'.repeat(70_000) }))), [413, 'PAYLOAD_TOO_LARGE']);
  // Экранированный текст в пределах 10 000 code units проходит лимит тела.
  assert.equal((await req(JSON.stringify({ text: '\u0001'.repeat(10_000) }))).statusCode, 201);

  for (const key of ['', 'a'.repeat(129), 'bad key', 'ключ', 'a/b']) {
    assert.deepEqual(await code(post(app, 'a', key)), [400, 'VALIDATION_ERROR'], `key=${key}`);
  }
  assert.equal((await post(app, 'a', 'Az09._-'.padEnd(128, 'x'))).statusCode, 201);
  // Регистрозависимый ключ.
  assert.equal((await post(app, 'a', 'Key')).statusCode, 201);
  assert.equal((await post(app, 'b', 'key')).statusCode, 201);

  assert.deepEqual(await code(app.inject({ method: 'GET', url: '/jobs/not-a-uuid' })), [400, 'VALIDATION_ERROR']);
  assert.deepEqual(await code(app.inject({ method: 'POST', url: '/jobs/not-a-uuid/cancel' })), [400, 'VALIDATION_ERROR']);
  const unknown = '00000000-0000-4000-8000-000000000000';
  assert.deepEqual(await code(app.inject({ method: 'GET', url: `/jobs/${unknown}` })), [404, 'NOT_FOUND']);
  assert.deepEqual(await code(app.inject({ method: 'POST', url: `/jobs/${unknown}/cancel` })), [404, 'NOT_FOUND']);
  await app.close();
  db.close();
});
