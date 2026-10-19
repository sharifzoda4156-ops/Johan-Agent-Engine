import http from 'node:http';
import { createStore } from './store.js';

const MAX_BODY = 64 * 1024;

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers);
    return res.end();
  }
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const fail = (res, status, code, message) => send(res, status, { error: { code, message } });

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) reject(Object.assign(new Error('too large'), { status: 413 }));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validNote(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every((k) => k === 'title' || k === 'body')
    && typeof input.title === 'string' && input.title.length >= 1 && input.title.length <= 200
    && typeof input.body === 'string' && input.body.length <= 10000;
}

export function createApp(store = createStore()) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const match = pathname.match(/^\/notes\/([^/]+)$/);
    try {
      if (pathname === '/notes' && req.method === 'POST') {
        const input = await readJson(req);
        if (!validNote(input)) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid note');
        const note = store.create(input);
        return send(res, 201, note, { location: `/notes/${note.id}` });
      }
      if (match && req.method === 'GET') {
        const note = store.get(match[1]);
        if (!note) return fail(res, 404, 'NOT_FOUND', 'Note not found');
        return send(res, 200, note);
      }
      if (match && req.method === 'PUT') {
        const input = await readJson(req);
        if (!validNote(input)) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid note');
        const note = store.update(match[1], input);
        if (!note) return fail(res, 404, 'NOT_FOUND', 'Note not found');
        return send(res, 200, note);
      }
      if (match && req.method === 'DELETE') {
        if (!store.delete(match[1])) return fail(res, 404, 'NOT_FOUND', 'Note not found');
        return send(res, 204);
      }
      return fail(res, 404, 'NOT_FOUND', 'Route not found');
    } catch (err) {
      if (err.status === 413) return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Body too large');
      if (err.status === 400) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid JSON');
      return fail(res, 500, 'INTERNAL', 'Internal error');
    }
  });
}
