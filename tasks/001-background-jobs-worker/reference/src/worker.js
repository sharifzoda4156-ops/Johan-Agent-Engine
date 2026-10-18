import { setTimeout as delay } from 'node:timers/promises';
import { createJobStore, LEASE_MS } from './jobs.js';
import { countWords } from './countWords.js';

// Worker: захват (короткая транзакция) → обработка вне транзакции → условная запись итога.
export function createWorker({
  db,
  now = Date.now,
  process: processText = countWords,
  leaseMs = LEASE_MS,
  pollMs = 500,
  log = () => {},
} = {}) {
  const store = createJobStore(db, { now });
  let stopping = false;
  let wake = null;

  async function runOnce() {
    const job = store.claim(leaseMs);
    if (!job) return null;
    let result;
    try {
      result = await processText(job.text);
    } catch (err) {
      const row = store.fail(job.id, job.claim_token, err?.message || 'PROCESSING_ERROR');
      if (!row) log(`job ${job.id}: lease lost, error not saved`);
      return { job, outcome: row ? row.state : 'lease_lost' };
    }
    const row = store.complete(job.id, job.claim_token, result);
    if (!row) log(`job ${job.id}: lease lost, result not saved`);
    return { job, outcome: row ? 'completed' : 'lease_lost' };
  }

  async function run() {
    while (!stopping) {
      let did = null;
      try {
        did = await runOnce();
      } catch (err) {
        log(`worker error: ${err.message}`);
      }
      if (!did && !stopping) {
        const ac = new AbortController();
        wake = () => ac.abort();
        await delay(pollMs, undefined, { signal: ac.signal }).catch(() => {});
        wake = null;
      }
    }
  }

  return {
    runOnce,
    run,
    // Текущее задание дорабатывается, новые не захватываются.
    stop() {
      stopping = true;
      wake?.();
    },
  };
}
