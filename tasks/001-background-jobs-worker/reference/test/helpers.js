import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

export function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-'));
  return path.join(dir, 'jobs.sqlite');
}

export function fakeClock(start = 1_700_000_000_000) {
  const clock = { t: start, now: () => clock.t, advance: (ms) => { clock.t += ms; } };
  return clock;
}

export function setup() {
  const file = tempDbPath();
  const db = openDb(file);
  return { file, db, clock: fakeClock() };
}

export async function post(app, text, key) {
  const headers = { 'content-type': 'application/json' };
  if (key !== undefined) headers['idempotency-key'] = key;
  return app.inject({ method: 'POST', url: '/jobs', headers, payload: JSON.stringify({ text }) });
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
