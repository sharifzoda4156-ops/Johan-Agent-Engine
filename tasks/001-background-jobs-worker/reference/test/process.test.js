import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tempDbPath } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function start(script, env) {
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const waitFor = (re) => new Promise((resolve, reject) => {
    const check = () => { const m = out.match(re); if (m) { clearInterval(t); resolve(m); } };
    const t = setInterval(check, 10);
    child.once('exit', (c) => { clearInterval(t); if (!out.match(re)) reject(new Error(`exited ${c}: ${out}`)); });
  });
  return { child, waitFor, output: () => out };
}

async function stop(proc, signal) {
  const exit = once(proc.child, 'exit');
  proc.child.kill(signal);
  const [code] = await exit;
  return code;
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`процессы API и worker корректно закрываются по ${signal}; рестарт сохраняет задания`, async () => {
    const DATABASE_PATH = tempDbPath();
    const api = start('bin/api.js', { DATABASE_PATH, PORT: '0' });
    const [, base] = await api.waitFor(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
    const res = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'p1' }, body: '{"text":"hello real world"}' });
    assert.equal(res.status, 201);
    const { id } = await res.json();
    assert.equal(await stop(api, signal), 0);

    // Worker запускается после остановки API — задание лежит в файловой БД.
    const worker = start('bin/worker.js', { DATABASE_PATH, WORKER_POLL_MS: '20' });
    await worker.waitFor(/worker started/);
    const api2 = start('bin/api.js', { DATABASE_PATH, PORT: '0' });
    const [, base2] = await api2.waitFor(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
    let job;
    for (let i = 0; i < 200; i++) {
      job = await (await fetch(`${base2}/jobs/${id}`)).json();
      if (job.state === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(job, { id, state: 'completed', result: { wordCount: 3 }, attempts: 1, error: null });
    assert.equal(await stop(worker, signal), 0);
    assert.match(worker.output(), /worker stopped/);
    assert.equal(await stop(api2, signal), 0);
  });
}
