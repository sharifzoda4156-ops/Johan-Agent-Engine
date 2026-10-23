import { randomUUID } from 'node:crypto';
import { now } from './db.js';

/**
 * Lease duration in milliseconds. A claimed job is owned by its worker for
 * this long; after that the lease is considered expired and the job may be
 * reclaimed (while attempts remain).
 */
const LEASE_MS = 10_000;

/**
 * Map a raw SQLite row to a job object.
 *
 * @param {object | undefined} row
 * @returns {object | null}
 */
function toJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    attempts: row.attempts,
    result: row.result,
    error: row.error,
    claimToken: row.claim_token,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository for the jobs queue.
 *
 * All methods operate on a better-sqlite3 Database handle created by
 * `openDatabase` (see src/db.js). Timestamps are always taken from `now()`
 * so tests can substitute a controllable clock.
 *
 * The concrete transactional bodies are implemented by the following
 * subpoints of this task:
 *   2. createJob  — idempotency via UNIQUE(idempotency_key)
 *   3. cancelJob  — queued -> cancelled, 409 on running/terminal
 *   4. claimNext  — atomic queued|expired-lease -> running
 *   5. expireLease — running with expired lease -> failed/queued
 *   6. completeJob — running + matching claim_token + live lease -> completed
 *   7. failJob    — running + matching claim_token + live lease -> queued|failed
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createRepo(db) {
  if (!db) throw new Error('createRepo requires a database handle');

  return {
    /**
     * Create a job, honouring idempotency_key.
     *
     * @param {{ text: string, idempotencyKey?: string | null }} input
     * @returns {{ job: object, reused: boolean }}
     */
    createJob(input) {
      const { text, idempotencyKey = null } = input ?? {};
      const key = idempotencyKey ?? null;

      const findByKey = db.prepare(
        'SELECT * FROM jobs WHERE idempotency_key = ?'
      );
      const insert = db.prepare(`
        INSERT INTO jobs (id, text, idempotency_key, state, attempts, created_at, updated_at)
        VALUES (@id, @text, @idempotency_key, 'queued', 0, @created_at, @updated_at)
      `);

      const run = db.transaction(() => {
        if (key !== null) {
          const existing = findByKey.get(key);
          if (existing) {
            if (existing.text !== text) {
              throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'), {
                code: 'IDEMPOTENCY_CONFLICT',
              });
            }
            return { job: toJob(existing), reused: true };
          }
        }

        const ts = now();
        const id = randomUUID();
        try {
          insert.run({
            id,
            text,
            idempotency_key: key,
            created_at: ts,
            updated_at: ts,
          });
        } catch (err) {
          // Lost the race on the UNIQUE(idempotency_key) constraint: re-read.
          if (key !== null && err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            const existing = findByKey.get(key);
            if (existing) {
              if (existing.text !== text) {
                throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'), {
                  code: 'IDEMPOTENCY_CONFLICT',
                });
              }
              return { job: toJob(existing), reused: true };
            }
          }
          throw err;
        }

        return { job: toJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)), reused: false };
      });

      return run();
    },

    /**
     * Fetch a job by id.
     *
     * @param {string} id
     * @returns {object | null}
     */
    getJob(id) {
      return toJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    },

    /**
     * Cancel a queued job.
     *
     * - Unknown id            -> NOT_FOUND
     * - Already cancelled     -> returned as-is (idempotent)
     * - queued                -> conditional UPDATE queued -> cancelled
     * - running               -> JOB_ALREADY_STARTED
     * - completed | failed    -> JOB_TERMINAL
     *
     * The conditional UPDATE (WHERE state='queued') serialises the race with
     * claimNext: exactly one of cancel/claim wins.
     *
     * @param {string} id
     * @returns {object}
     */
    cancelJob(id) {
      const select = db.prepare('SELECT * FROM jobs WHERE id = ?');
      const cancel = db.prepare(`
        UPDATE jobs
        SET state = 'cancelled', updated_at = @updated_at
        WHERE id = @id AND state = 'queued'
      `);

      const run = db.transaction(() => {
        const row = select.get(id);
        if (!row) {
          throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
        }

        if (row.state === 'cancelled') {
          return toJob(row);
        }

        if (row.state === 'queued') {
          const ts = now();
          const info = cancel.run({ id, updated_at: ts });
          if (info.changes === 0) {
            // Lost the race with claimNext: re-read the current state.
            const current = select.get(id);
            if (!current) {
              throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
            }
            if (current.state === 'cancelled') return toJob(current);
            if (current.state === 'running') {
              throw Object.assign(new Error('JOB_ALREADY_STARTED'), {
                code: 'JOB_ALREADY_STARTED',
              });
            }
            throw Object.assign(new Error('JOB_TERMINAL'), { code: 'JOB_TERMINAL' });
          }
          return toJob(select.get(id));
        }

        if (row.state === 'running') {
          throw Object.assign(new Error('JOB_ALREADY_STARTED'), {
            code: 'JOB_ALREADY_STARTED',
          });
        }

        // completed | failed
        throw Object.assign(new Error('JOB_TERMINAL'), { code: 'JOB_TERMINAL' });
      });

      return run();
    },

    /**
     * Atomically claim the next runnable job (queued, or running with an
     * expired lease and attempts remaining).
     *
     * @param {number} [timestamp] Unix ms to treat as "now"; defaults to now().
     * @returns {object | null}
     */
    claimNext(timestamp) {
      const claim = db.prepare(`
        UPDATE jobs
        SET state = 'running',
            claim_token = @claim_token,
            lease_until = @lease_until,
            attempts = attempts + 1,
            updated_at = @updated_at
        WHERE id = (
          SELECT id FROM jobs
          WHERE (state = 'queued')
             OR (state = 'running' AND lease_until < @now AND attempts < 3)
          ORDER BY created_at
          LIMIT 1
        )
          AND ((state = 'queued')
            OR (state = 'running' AND lease_until < @now AND attempts < 3))
        RETURNING *
      `);

      const run = db.transaction(() => {
        const ts = timestamp ?? now();
        const row = claim.get({
          claim_token: randomUUID(),
          lease_until: ts + LEASE_MS,
          updated_at: ts,
          now: ts,
        });
        return toJob(row);
      });

      return run();
    },

    /**
     * Mark a running job as completed, guarded by claim_token and lease.
     *
     * @param {string} id
     * @param {string} claimToken
     * @param {number} result
     * @param {number} [timestamp] Unix ms to treat as "now"; defaults to now().
     * @returns {boolean}
     */
    completeJob(id, claimToken, result, timestamp) {
      const complete = db.prepare(`
        UPDATE jobs
        SET state = 'completed',
            result = @result,
            error = NULL,
            claim_token = NULL,
            lease_until = NULL,
            updated_at = @updated_at
        WHERE id = @id
          AND state = 'running'
          AND claim_token = @claim_token
          AND lease_until >= @now
      `);

      const run = db.transaction(() => {
        const ts = timestamp ?? now();
        const info = complete.run({
          id,
          claim_token: claimToken,
          result,
          updated_at: ts,
          now: ts,
        });
        return info.changes > 0;
      });

      return run();
    },

    /**
     * Record a processing failure, guarded by claim_token and lease.
     * Requeues while attempts remain, otherwise marks the job failed.
     *
     * @param {string} id
     * @param {string} claimToken
     * @param {string} error
     * @param {number} [timestamp] Unix ms to treat as "now"; defaults to now().
     * @returns {boolean}
     */
    failJob(id, claimToken, error, timestamp) {
      const select = db.prepare(
        'SELECT attempts, state, claim_token, lease_until FROM jobs WHERE id = ?'
      );
      const requeue = db.prepare(`
        UPDATE jobs
        SET state = 'queued',
            error = @error,
            claim_token = NULL,
            lease_until = NULL,
            updated_at = @updated_at
        WHERE id = @id
          AND state = 'running'
          AND claim_token = @claim_token
          AND lease_until >= @now
      `);
      const fail = db.prepare(`
        UPDATE jobs
        SET state = 'failed',
            error = @error,
            claim_token = NULL,
            lease_until = NULL,
            updated_at = @updated_at
        WHERE id = @id
          AND state = 'running'
          AND claim_token = @claim_token
          AND lease_until >= @now
      `);

      const run = db.transaction(() => {
        const ts = timestamp ?? now();
        const row = select.get(id);

        // Unknown job, or not owned by this worker's live claim: refuse.
        if (!row) return false;
        if (row.state !== 'running') return false;
        if (row.claim_token !== claimToken) return false;
        if (row.lease_until === null || row.lease_until < ts) return false;

        // attempts was already incremented by the successful claim, so
        // attempts < 3 means at least one retry remains.
        const stmt = row.attempts < 3 ? requeue : fail;
        const info = stmt.run({
          id,
          claim_token: claimToken,
          error,
          updated_at: ts,
          now: ts,
        });

        return info.changes > 0;
      });

      return run();
    },

    /**
     * Recover jobs whose lease has expired: requeue while attempts remain,
     * otherwise mark failed with error='LEASE_EXPIRED'.
     *
     * @param {number} [timestamp] Unix ms to treat as "now"; defaults to now().
     * @returns {number} number of jobs transitioned
     */
    expireLease(timestamp) {
      const expire = db.prepare(`
        UPDATE jobs
        SET state = 'failed',
            error = 'LEASE_EXPIRED',
            claim_token = NULL,
            lease_until = NULL,
            updated_at = @updated_at
        WHERE state = 'running'
          AND lease_until < @now
          AND attempts >= 3
      `);

      const run = db.transaction(() => {
        const ts = timestamp ?? now();
        const info = expire.run({ updated_at: ts, now: ts });
        return info.changes;
      });

      return run();
    },
  };
}
