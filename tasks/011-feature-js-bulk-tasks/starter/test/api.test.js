import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http.js';
import { TaskService } from '../src/service.js';
import { TaskStore } from '../src/store.js';
import { TasksClient } from '../src/client.js';

let server;
let client;

before(async () => {
  server = createServer(new TaskService(new TaskStore()));
  await new Promise((r) => server.listen(0, r));
  client = new TasksClient(`http://127.0.0.1:${server.address().port}`);
});
after(() => server.close());

test('create, update, list, delete', async () => {
  const t = await client.create({ title: '  Buy milk ' });
  assert.deepEqual(t, { id: t.id, title: 'Buy milk', done: false, priority: 3 });
  assert.equal((await client.update(t.id, { done: true })).done, true);
  assert.equal((await client.list()).length, 1);
  await client.remove(t.id);
  assert.deepEqual(await client.list(), []);
});

test('validation and not found', async () => {
  await assert.rejects(client.create({ title: '' }), { status: 400, code: 'VALIDATION_ERROR' });
  await assert.rejects(client.update('nope', { done: true }), { status: 404, code: 'NOT_FOUND' });
});
