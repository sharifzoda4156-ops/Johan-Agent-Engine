import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function start() {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('create, read, update, delete', async () => {
  const { call, close } = await start();
  const created = await call('POST', '/notes', { title: 'a', body: 'b' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await call('GET', `/notes/${id}`)).body.title, 'a');
  assert.equal((await call('PUT', `/notes/${id}`, { title: 'c', body: '' })).body.title, 'c');
  assert.equal((await call('DELETE', `/notes/${id}`)).status, 204);
  assert.equal((await call('GET', `/notes/${id}`)).status, 404);
  await close();
});

test('validation', async () => {
  const { call, close } = await start();
  assert.equal((await call('POST', '/notes', { title: '' , body: '' })).status, 400);
  assert.equal((await call('POST', '/notes', { title: 'x', body: 'y', extra: 1 })).status, 400);
  await close();
});
