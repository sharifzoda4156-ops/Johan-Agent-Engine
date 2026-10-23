/**
 * Worker loop: recover expired leases, claim the next runnable job, process it
 * outside any transaction, then record the outcome under the claim's token.
 *
 * `processJob` is pure, so a crash between claim and completion simply leaves
 * the lease to expire and the job is picked up again by a later claim — the
 * guarantee is a correct stored result, not exactly-once execution.
 */

import { pathToFileURL } from 'node:url';
import {
  now as systemNow,
  openDatabase,
  closeDatabase,
  DEFAULT_DATABASE_PATH,
} from './db.js';
import { createRepo } from './repo.js';
import { processJob as defaultProcessJob } from './processor.js';

/**
 * How long to wait before polling again when the queue is empty.
 */
export const POLL_INTERVAL_MS = 50;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single claim/process/complete cycle.
 *
 * @param {object} deps
 * @param {object} deps.repo
 * @param {(text: string) => { wordCount: number } | Promise<{ wordCount: number }>} [deps.processJob]
 * @param {() => number} [deps.now]
 * @returns {Promise<boolean>} true when a job was claimed and handled
 */
export async function runOnce({ repo, processJob = defaultProcessJob, now = systemNow }) {
  repo.expireLease(now());

  const job = repo.claimNext(now());
  if (!job) return false;

  try {
    // Processing happens outside any transaction; the lease is the only guard.
    const result = await processJob(job.text);
    // Fresh timestamp: processing may have outlived the lease.
    repo.completeJob(job.id, job.claimToken, result.wordCount, now());
  } catch (err) {
    repo.failJob(job.id, job.claimToken, err?.message ?? String(err), now());
  }

  return true;
}

/**
 * The worker loop. When the queue is empty, wait `pollIntervalMs` before
 * polling again.
 *
 * @param {object} deps
 * @param {object} deps.repo
 * @param {(text: string) => { wordCount: number } | Promise<{ wordCount: number }>} [deps.processJob]
 * @param {() => number} [deps.now]
 * @param {number} [deps.pollIntervalMs]
 * @returns {Promise<void>}
 */
export async function runLoop({
  repo,
  processJob = defaultProcessJob,
  now = systemNow,
  pollIntervalMs = POLL_INTERVAL_MS,
}) {
  for (;;) {
    const handled = await runOnce({ repo, processJob, now });
    if (!handled) await delay(pollIntervalMs);
  }
}

/**
 * Create a controllable worker instance.
 *
 * Wraps the claim/process/complete loop in a start/stop lifecycle so tests can
 * drive it with an injected clock (`now`), an injected `processJob` (to
 * simulate failures) and a short `pollIntervalMs`, then await a clean stop.
 *
 * `stop()` flips the loop flag and resolves once the in-flight iteration has
 * finished, so no job is left half-processed. `close()` additionally closes the
 * database handle. Signal handling is wired up by the caller.
 *
 * @param {object} deps
 * @param {object} [deps.db] database handle, closed by `close()`
 * @param {object} deps.repo
 * @param {(text: string) => { wordCount: number } | Promise<{ wordCount: number }>} [deps.processJob]
 * @param {() => number} [deps.now]
 * @param {number} [deps.pollIntervalMs]
 * @returns {{
 *   start: () => Promise<void>,
 *   stop: () => Promise<void>,
 *   close: () => Promise<void>,
 *   runOnce: () => Promise<boolean>,
 *   readonly running: boolean,
 * }}
 */
export function createWorker({
  db,
  repo,
  processJob = defaultProcessJob,
  now = systemNow,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  if (!repo) throw new Error('createWorker requires a repo');

  let running = false;
  let stopped = false;
  let current = Promise.resolve();

  async function loop() {
    while (!stopped) {
      const handled = await runOnce({ repo, processJob, now });
      if (!handled) await delay(pollIntervalMs);
    }
  }

  function start() {
    if (running) return current;
    running = true;
    stopped = false;
    current = loop().finally(() => {
      running = false;
    });
    return current;
  }

  async function stop() {
    stopped = true;
    await current;
  }

  async function close() {
    await stop();
    closeDatabase(db);
  }

  return {
    get running() {
      return running;
    },
    start,
    stop,
    close,
    runOnce() {
      return runOnce({ repo, processJob, now });
    },
  };
}

/**
 * Wire SIGINT/SIGTERM to a graceful worker shutdown.
 *
 * On the first signal the loop is stopped, the in-flight iteration is awaited
 * (so no job is left half-processed) and the database handle is closed. Further
 * signals while shutting down are ignored. Returns an uninstall function so
 * tests can detach the handlers again.
 *
 * @param {{ close: () => Promise<void> }} worker
 * @param {object} [options]
 * @param {string[]} [options.signals]
 * @param {(code: number) => void} [options.exit]
 * @returns {() => void} uninstall
 */
export function installSignalHandlers(
  worker,
  { signals = ['SIGINT', 'SIGTERM'], exit = process.exit } = {}
) {
  let shuttingDown = false;
  const handlers = new Map();

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // stop() waits for the current iteration; close() also closes the DB.
      await worker.close();
    } catch (err) {
      console.error(`worker shutdown failed after ${signal}:`, err);
    } finally {
      exit(0);
    }
  };

  for (const signal of signals) {
    const handler = () => {
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };
}

/**
 * Worker entry point: open the database, build the repo and run the loop until
 * a SIGINT/SIGTERM arrives.
 *
 * @returns {Promise<void>}
 */
export async function main() {
  const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  const db = openDatabase(dbPath);
  const repo = createRepo(db);
  const worker = createWorker({ db, repo });

  installSignalHandlers(worker);

  // Resolves once the loop has been stopped by a signal.
  await worker.start();
}

// Only run the loop when this module is executed directly (`npm run start:worker`),
// not when it is imported by tests.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
