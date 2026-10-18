import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDb, openDb } from '../src/db.js';
import {
  claimJob,
  completeJob,
  createJob,
  failJob,
  getJob,
} from '../src/jobs.js';
import { buildServer } from '../src/api.js';
import {
  createApiFixture,
  createClock,
  createTempDb,
  getJob as apiGetJob,
  postJob,
} from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Ask the OS for a free TCP port by binding to port 0 and reading the
 * assigned port back. The socket is closed before returning, so there is a
 * small race window, but it is good enough for a local test.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Spawn a Node entry point (src/api.js or src/worker.js) with the given env,
 * wait until it is ready (or a short grace period elapses), send `signal`,
 * and resolve with the exit code. Rejects if the process does not exit within
 * `timeoutMs`.
 */
function spawnAndSignal(scriptPath, env, signal, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `Process ${scriptPath} did not exit after ${signal} within ${timeoutMs}ms\n` +
            `stdout: ${stdout}\nstderr: ${stderr}`
        )
      );
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, exitSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, exitSignal, stdout, stderr });
    });

    // Give the process a moment to install signal handlers and open the DB
    // before we deliver the signal.
    setTimeout(() => {
      if (!settled) {
        child.kill(signal);
      }
    }, 300);
  });
}

test('closing and reopening the file-backed DB preserves jobs, results, errors and idempotency keys', async () => {
  const temp = createTempDb({ prefix: 'jobs-persist-' });
  const clock = createClock();
  const dbPath = temp.path;

  try {
    // --- First "process": create and finish some jobs, then close the DB. ---
    const db1 = temp.db;

    // A completed job with a result.
    const completed = createJob(db1, {
      text: 'one two three four',
      idempotencyKey: 'key-completed',
      now: clock(),
    });
    assert.equal(completed.status, 201);
    const completedId = completed.job.id;

    const claimed = claimJob(db1, {
      now: clock(),
      leaseMs: 10_000,
      maxAttempts: 3,
    });
    assert.ok(claimed);
    assert.equal(claimed.id, completedId);

    const done = completeJob(db1, {
      id: completedId,
      claimToken: claimed.claim_token,
      result: 4,
      now: clock(),
    });
    assert.equal(done.status, 200);
    assert.equal(done.job.state, 'completed');
    assert.equal(done.job.result, 4);

    // A failed job with a preserved error (attempts exhausted).
    const failing = createJob(db1, {
      text: 'alpha beta',
      idempotencyKey: 'key-failed',
      now: clock(),
    });
    assert.equal(failing.status, 201);
    const failingId = failing.job.id;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const c = claimJob(db1, {
        now: clock(),
        leaseMs: 10_000,
        maxAttempts: 3,
      });
      assert.ok(c);
      assert.equal(c.id, failingId);
      const f = failJob(db1, {
        id: failingId,
        claimToken: c.claim_token,
        error: 'boom',
        now: clock(),
        maxAttempts: 3,
      });
      assert.equal(f.status, 200);
    }

    const failedRow = getJob(db1, failingId);
    assert.equal(failedRow.state, 'failed');
    assert.equal(failedRow.error, 'boom');
    assert.equal(failedRow.attempts, 3);

    // A still-queued job to check that queued state survives too.
    const queued = createJob(db1, {
      text: 'queued text',
      idempotencyKey: 'key-queued',
      now: clock(),
    });
    assert.equal(queued.status, 201);
    const queuedId = queued.job.id;

    // Close the first "process" connection.
    closeDb(db1);

    // --- Second "process": reopen the same file and verify everything. ---
    const db2 = openDb(dbPath);
    try {
      const completedRow = getJob(db2, completedId);
      assert.ok(completedRow);
      assert.equal(completedRow.state, 'completed');
      assert.equal(completedRow.result, 4);
      assert.equal(completedRow.attempts, 1);
      assert.equal(completedRow.error, null);
      assert.equal(completedRow.idempotency_key, 'key-completed');

      const failedRow2 = getJob(db2, failingId);
      assert.ok(failedRow2);
      assert.equal(failedRow2.state, 'failed');
      assert.equal(failedRow2.error, 'boom');
      assert.equal(failedRow2.attempts, 3);
      assert.equal(failedRow2.idempotency_key, 'key-failed');

      const queuedRow = getJob(db2, queuedId);
      assert.ok(queuedRow);
      assert.equal(queuedRow.state, 'queued');
      assert.equal(queuedRow.attempts, 0);
      assert.equal(queuedRow.idempotency_key, 'key-queued');

      // Idempotency keys still resolve to the same jobs after restart.
      const replay = createJob(db2, {
        text: 'one two three four',
        idempotencyKey: 'key-completed',
        now: clock(),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.job.id, completedId);

      const conflict = createJob(db2, {
        text: 'different text',
        idempotencyKey: 'key-completed',
        now: clock(),
      });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
    } finally {
      closeDb(db2);
    }
  } finally {
    temp.cleanup();
  }
});

test('API serves persisted jobs after a restart (close + reopen the file DB)', async () => {
  const temp = createTempDb({ prefix: 'jobs-persist-api-' });
  const clock = createClock();
  const dbPath = temp.path;

  let firstApp;
  let secondApp;
  try {
    // First API instance: create a job and complete it via the worker path.
    firstApp = buildServer({ db: temp.db, now: clock });
    const created = await postJob(firstApp, { text: 'hello world' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    const claimed = claimJob(temp.db, {
      now: clock(),
      leaseMs: 10_000,
      maxAttempts: 3,
    });
    assert.ok(claimed);
    completeJob(temp.db, {
      id,
      claimToken: claimed.claim_token,
      result: 2,
      now: clock(),
    });

    await firstApp.close();
    firstApp = undefined;
    closeDb(temp.db);

    // Second API instance: reopen the same file and read the job back.
    const db2 = openDb(dbPath);
    secondApp = buildServer({ db: db2, now: clock });

    const fetched = await apiGetJob(secondApp, id);
    assert.equal(fetched.statusCode, 200);
    const body = fetched.json();
    assert.equal(body.id, id);
    assert.equal(body.state, 'completed');
    assert.deepEqual(body.result, { wordCount: 2 });
    assert.equal(body.attempts, 1);
    assert.equal(body.error, null);

    await secondApp.close();
    secondApp = undefined;
    closeDb(db2);
  } finally {
    if (firstApp) {
      await firstApp.close();
    }
    if (secondApp) {
      await secondApp.close();
    }
    temp.cleanup();
  }
});

test('API process exits cleanly on SIGINT and SIGTERM', async () => {
  const temp = createTempDb({ prefix: 'jobs-sig-api-' });
  try {
    const port = await getFreePort();
    const env = {
      DATABASE_PATH: temp.path,
      PORT: String(port),
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
      const result = await spawnAndSignal(
        path.join(REPO_ROOT, 'src', 'api.js'),
        env,
        signal
      );
      assert.equal(
        result.code,
        0,
        `API exited with code ${result.code} on ${signal}\n` +
          `stdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }
  } finally {
    temp.cleanup();
  }
});

test('worker process exits cleanly on SIGINT and SIGTERM', async () => {
  const temp = createTempDb({ prefix: 'jobs-sig-worker-' });
  try {
    const env = {
      DATABASE_PATH: temp.path,
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
      const result = await spawnAndSignal(
        path.join(REPO_ROOT, 'src', 'worker.js'),
        env,
        signal
      );
      assert.equal(
        result.code,
        0,
        `worker exited with code ${result.code} on ${signal}\n` +
          `stdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }
  } finally {
    temp.cleanup();
  }
});
