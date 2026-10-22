import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function start() {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? { ...extraHeaders } : { 'content-type': 'application/json', ...extraHeaders },
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
  const updated = await call('PUT', `/notes/${id}`, { title: 'c', body: '' }, { 'if-match': created.headers.get('etag') });
  assert.equal(updated.body.title, 'c');
  assert.equal((await call('DELETE', `/notes/${id}`, undefined, { 'if-match': updated.headers.get('etag') })).status, 204);
  assert.equal((await call('GET', `/notes/${id}`)).status, 404);
  await close();
});

test('version and etag', async () => {
  const { call, close } = await start();
  const created = await call('POST', '/notes', { title: 'a', body: 'b' });
  assert.equal(created.status, 201);
  assert.equal(created.body.version, 1);
  assert.equal(created.headers.get('etag'), '"1"');
  const id = created.body.id;

  const fetched = await call('GET', `/notes/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.version, 1);
  assert.equal(fetched.headers.get('etag'), '"1"');

  const updated = await call('PUT', `/notes/${id}`, { title: 'c', body: 'd' }, { 'if-match': created.headers.get('etag') });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.version, 2);
  assert.equal(updated.headers.get('etag'), '"2"');

  const refetched = await call('GET', `/notes/${id}`);
  assert.equal(refetched.body.version, 2);
  assert.equal(refetched.headers.get('etag'), '"2"');
  await close();
});

test('if-none-match', async () => {
  const { call, close } = await start();
  const created = await call('POST', '/notes', { title: 'a', body: 'b' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const tag = created.headers.get('etag');
  assert.equal(tag, '"1"');

  const matched = await call('GET', `/notes/${id}`, undefined, { 'if-none-match': tag });
  assert.equal(matched.status, 304);
  assert.equal(matched.headers.get('etag'), '"1"');
  assert.equal(matched.body, null);

  const wildcard = await call('GET', `/notes/${id}`, undefined, { 'if-none-match': '*' });
  assert.equal(wildcard.status, 304);
  assert.equal(wildcard.headers.get('etag'), '"1"');
  assert.equal(wildcard.body, null);

  const weak = await call('GET', `/notes/${id}`, undefined, { 'if-none-match': 'W/"1"' });
  assert.equal(weak.status, 304);
  assert.equal(weak.headers.get('etag'), '"1"');
  assert.equal(weak.body, null);

  const notMatched = await call('GET', `/notes/${id}`, undefined, { 'if-none-match': '"2"' });
  assert.equal(notMatched.status, 200);
  assert.equal(notMatched.headers.get('etag'), '"1"');
  assert.equal(notMatched.body.title, 'a');
  await close();
});

test('if-match preconditions', async () => {
  const { call, close } = await start();
  const created = await call('POST', '/notes', { title: 'a', body: 'b' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const tag = created.headers.get('etag');
  assert.equal(tag, '"1"');

  const putNoMatch = await call('PUT', `/notes/${id}`, { title: 'c', body: 'd' });
  assert.equal(putNoMatch.status, 428);

  const deleteNoMatch = await call('DELETE', `/notes/${id}`);
  assert.equal(deleteNoMatch.status, 428);

  const putMismatch = await call('PUT', `/notes/${id}`, { title: 'c', body: 'd' }, { 'if-match': '"2"' });
  assert.equal(putMismatch.status, 412);
  assert.equal(putMismatch.headers.get('etag'), '"1"');

  const deleteMismatch = await call('DELETE', `/notes/${id}`, undefined, { 'if-match': '"2"' });
  assert.equal(deleteMismatch.status, 412);
  assert.equal(deleteMismatch.headers.get('etag'), '"1"');

  const putWeak = await call('PUT', `/notes/${id}`, { title: 'c', body: 'd' }, { 'if-match': 'W/"1"' });
  assert.equal(putWeak.status, 412);
  assert.equal(putWeak.headers.get('etag'), '"1"');

  const deleteWeak = await call('DELETE', `/notes/${id}`, undefined, { 'if-match': 'W/"1"' });
  assert.equal(deleteWeak.status, 412);
  assert.equal(deleteWeak.headers.get('etag'), '"1"');

  const putWildcard = await call('PUT', `/notes/${id}`, { title: 'c', body: 'd' }, { 'if-match': '*' });
  assert.equal(putWildcard.status, 200);
  assert.equal(putWildcard.body.version, 2);
  assert.equal(putWildcard.headers.get('etag'), '"2"');

  const deleteWildcard = await call('DELETE', `/notes/${id}`, undefined, { 'if-match': '*' });
  assert.equal(deleteWildcard.status, 204);
  await close();
});

test('validation', async () => {
  const { call, close } = await start();
  assert.equal((await call('POST', '/notes', { title: '' , body: '' })).status, 400);
  assert.equal((await call('POST', '/notes', { title: 'x', body: 'y', extra: 1 })).status, 400);
  await close();
});

test('invalid body with matching if-match does not change version', async () => {
  const { call, close } = await start();
  const created = await call('POST', '/notes', { title: 'a', body: 'b' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const tag = created.headers.get('etag');
  assert.equal(tag, '"1"');

  const invalid = await call('PUT', `/notes/${id}`, { title: '', body: 'b' }, { 'if-match': tag });
  assert.equal(invalid.status, 400);

  const fetched = await call('GET', `/notes/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.version, 1);
  assert.equal(fetched.headers.get('etag'), '"1"');
  assert.equal(fetched.body.title, 'a');
  await close();
});

test('two clients editing the same note', async () => {
  const { call, close } = await start();
  const created = await call('POST', '/notes', { title: 'a', body: 'b' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const tag = created.headers.get('etag');
  assert.equal(tag, '"1"');

  const first = await call('PUT', `/notes/${id}`, { title: 'first', body: 'b' }, { 'if-match': tag });
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 2);
  assert.equal(first.headers.get('etag'), '"2"');

  const second = await call('PUT', `/notes/${id}`, { title: 'second', body: 'b' }, { 'if-match': tag });
  assert.equal(second.status, 412);
  assert.equal(second.headers.get('etag'), '"2"');

  const fetched = await call('GET', `/notes/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.version, 2);
  assert.equal(fetched.body.title, 'first');
  assert.equal(fetched.headers.get('etag'), '"2"');
  await close();
});
