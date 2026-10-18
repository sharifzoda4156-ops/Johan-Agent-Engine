//
// Background worker that drains the jobs queue.
//
// This sub-step only wires up the polling loop: on every tick it first sweeps
// expired leases (so that a `running` job whose lease has lapsed and whose
// attempt budget is exhausted is moved to `failed`), then tries to claim a
// job. When nothing is claimable it waits `pollIntervalMs` before the next
// tick. Actual job processing (completeJob/failJob) is added in a later
// sub-step.

import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { closeDb, openDb } from './db.js';
import { claimJob, completeJob, expireLeases, failJob } from './jobs.js';
import { countWords } from './wordCount.js';

export const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Default job handler: counts the words in the job text.
 *
 * Callers (and tests) can inject their own `processJob` to simulate
 * controlled failures; when omitted, this real handler is used.
 *
 * @param {string} text
 * @returns {Promise<number>} the word count
 */
export async function defaultProcessJob(text) {
  return countWords(text);
}

/**
 * Run the worker loop.
 *
 * @param {object}   options
 * @param {object}   options.db              better-sqlite3 database handle
 * @param {Function} options.now             clock, returns epoch millis
 * @param {number}   options.leaseMs         lease duration in millis
 * @param {number}   options.maxAttempts     max attempts per job
 * @param {Function} options.processJob      async (text) => result
 * @param {number}   [options.pollIntervalMs] idle wait between ticks
 * @param {object}   [options.signal]        AbortSignal to stop the loop
 * @returns {Promise<void>} resolves when the loop stops
 */
export async function runWorker({
  db,
  now,
  leaseMs,
  maxAttempts,
  processJob = defaultProcessJob,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now;

  while (!signal?.aborted) {
    // 1. Reap jobs whose lease expired and whose attempt budget is spent.
    expireLeases(db, { now: clock(), maxAttempts });

    // 2. Try to claim a job. `claimJob` returns the claimed row or null.
    const job = claimJob(db, { now: clock(), leaseMs, maxAttempts });

    if (job) {
      // Process the job outside of any transaction so a slow handler does not
      // hold a write lock on the database. The claim token guards the terminal
      // write: if the lease expired and the job was reclaimed (or expired) in
      // the meantime, completeJob/failJob refuse to touch the row.
      try {
        await processJob(job.text);
        completeJob(db, {
          id: job.id,
          claimToken: job.claim_token,
          result: countWords(job.text),
          now: clock(),
        });
      } catch (err) {
        failJob(db, {
          id: job.id,
          claimToken: job.claim_token,
          error: err instanceof Error ? err.message : String(err),
          now: clock(),
          maxAttempts,
        });
      }
      continue;
    }

    // 3. Nothing to do: wait before polling again.
    await sleep(pollIntervalMs, signal);
  }
}

/**
 * Sleep for `ms` milliseconds, resolving early if `signal` is aborted.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export default runWorker;

// Entry point: only runs when this module is executed directly
// (`node src/worker.js`), not when it is imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = openDb(config.databasePath);

  const controller = new AbortController();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Stop the polling loop; the worker will finish the current tick and
    // resolve once the abort is observed.
    controller.abort();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  runWorker({
    db,
    now: Date.now,
    leaseMs: config.leaseMs,
    maxAttempts: config.maxAttempts,
    signal: controller.signal,
  })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Worker loop failed:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      closeDb(db);
    });
}
