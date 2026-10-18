// src/jobs.js
//
// Job layer: the state transitions and idempotency rules of the job protocol,
// expressed as SQL against the `jobs` table created by src/db.js.
//
// This module is intentionally free of HTTP and worker concerns: it takes a
// better-sqlite3 Database handle and plain values, and returns plain objects.
// The API (src/api.js) and the worker (src/worker.js) are the callers.
//
// The module implements the full set of operations used by the API and the
// worker: createJob, getJob, cancelJob, claimJob, completeJob, failJob and
// expireLeases.

import crypto from 'node:crypto';

// Insert a new job, or resolve an existing one when the same idempotency key
// is submitted again.
//
// The insert runs inside a transaction and relies on the UNIQUE constraint on
// jobs.idempotency_key to serialize concurrent submissions of the same key:
// there is no check-then-insert race, because the database itself rejects the
// second insert. When that happens we read the row that won and compare its
// text with the incoming text:
//
//   - same text  -> the request is a retry of the same submission, so we
//                   return the previously created job with status 200;
//   - other text -> the key was reused for a different payload, which is a
//                   conflict, so we return status 409 with code
//                   IDEMPOTENCY_CONFLICT.
//
// Returns one of:
//   { status: 201, job }                          newly created
//   { status: 200, job }                          idempotent replay
//   { status: 409, code: 'IDEMPOTENCY_CONFLICT' } key reused with other text
export function createJob(db, { text, idempotencyKey, now }) {
  const id = crypto.randomUUID();
  const timestamp = now;

  const insert = db.prepare(`
    INSERT INTO jobs (
      id, text, idempotency_key, state, attempts,
      result, error, claim_token, lease_until,
      created_at, updated_at
    ) VALUES (
      @id, @text, @idempotency_key, 'queued', 0,
      NULL, NULL, NULL, NULL,
      @created_at, @updated_at
    )
  `);

  const selectByKey = db.prepare(`
    SELECT * FROM jobs WHERE idempotency_key = ?
  `);

  const run = db.transaction(() => {
    try {
      insert.run({
        id,
        text,
        idempotency_key: idempotencyKey,
        created_at: timestamp,
        updated_at: timestamp,
      });
      return { status: 201, job: selectByKey.get(idempotencyKey) };
    } catch (err) {
      // Only a UNIQUE violation on idempotency_key is expected here; anything
      // else (e.g. a CHECK failure) is a real error and must propagate.
      if (!isIdempotencyConflict(err)) {
        throw err;
      }

      const existing = selectByKey.get(idempotencyKey);
      if (!existing) {
        // The conflicting row disappeared between the failed insert and this
        // read. That should not happen under normal operation; surface the
        // original error rather than inventing a result.
        throw err;
      }

      if (existing.text === text) {
        return { status: 200, job: existing };
      }

      return { status: 409, code: 'IDEMPOTENCY_CONFLICT' };
    }
  });

  return run();
}

// Cancel a job by its id.
//
// Cancellation is a conditional UPDATE, not a read-then-write: the WHERE
// clause encodes the only state transition that is allowed (queued ->
// cancelled), so a concurrent claimJob() that has already moved the job to
// 'running' makes this UPDATE match zero rows. Exactly one of the two
// operations wins the race, and the loser observes the winner's state.
//
// Returns one of:
//   { status: 200, job }                          cancelled (or already so)
//   { status: 404, code: 'NOT_FOUND' }            no such job
//   { status: 409, code: 'JOB_ALREADY_STARTED' }  job is running
//   { status: 409, code: 'JOB_TERMINAL' }         job is completed or failed
export function cancelJob(db, id, now) {
  const cancelQueued = db.prepare(`
    UPDATE jobs
       SET state = 'cancelled',
           updated_at = @updated_at
     WHERE id = @id
       AND state = 'queued'
  `);

  const run = db.transaction(() => {
    const result = cancelQueued.run({ id, updated_at: now });

    // The UPDATE matched a queued row: the job is now cancelled.
    if (result.changes === 1) {
      return { status: 200, job: getJob(db, id) };
    }

    // No row was updated. Either the job does not exist, or it is in a state
    // that cannot be cancelled. Re-read to tell those cases apart.
    const existing = getJob(db, id);
    if (!existing) {
      return { status: 404, code: 'NOT_FOUND' };
    }

    if (existing.state === 'cancelled') {
      // Cancelling an already-cancelled job is idempotent.
      return { status: 200, job: existing };
    }

    if (existing.state === 'running') {
      return { status: 409, code: 'JOB_ALREADY_STARTED' };
    }

    // completed or failed: terminal states that cannot be cancelled.
    return { status: 409, code: 'JOB_TERMINAL' };
  });

  return run();
}

// Claim the next available job for processing.
//
// A job is claimable when it is either:
//   - 'queued' (never started), or
//   - 'running' with an expired lease (lease_until < now) and attempts left.
//
// The selection and the state transition happen inside a single transaction
// so that two workers cannot claim the same row: the UPDATE is conditional on
// the exact state/lease/attempts we selected, and only one of the concurrent
// transactions can match it. The loser's UPDATE affects zero rows and it
// simply returns null (the worker will retry on its next poll).
//
// attempts is incremented only here, i.e. only on a successful claim, so a
// job that is never picked up does not consume its retry budget.
//
// Returns the claimed job row (with the new claim_token, lease_until and
// attempts) or null when nothing is claimable.
export function claimJob(db, { now, leaseMs, maxAttempts }) {
  const selectClaimable = db.prepare(`
    SELECT id
      FROM jobs
     WHERE attempts < @max_attempts
       AND (
             state = 'queued'
          OR (state = 'running' AND lease_until < @now)
           )
     ORDER BY created_at
     LIMIT 1
  `);

  const claim = db.prepare(`
    UPDATE jobs
       SET state       = 'running',
           claim_token = @claim_token,
           lease_until = @lease_until,
           attempts    = attempts + 1,
           updated_at  = @updated_at
     WHERE id = @id
       AND attempts < @max_attempts
       AND (
             state = 'queued'
          OR (state = 'running' AND lease_until < @now)
           )
  `);

  const run = db.transaction(() => {
    const candidate = selectClaimable.get({ now, max_attempts: maxAttempts });
    if (!candidate) {
      return null;
    }

    const claimToken = crypto.randomUUID();
    const result = claim.run({
      id: candidate.id,
      claim_token: claimToken,
      lease_until: now + leaseMs,
      updated_at: now,
      now,
      max_attempts: maxAttempts,
    });

    // Another worker won the race between our SELECT and UPDATE.
    if (result.changes !== 1) {
      return null;
    }

    return getJob(db, candidate.id);
  });

  return run();
}

// Complete a job that this worker currently owns.
//
// Completion is a conditional UPDATE, not a read-then-write: the WHERE clause
// requires the caller's claim_token, state = 'running' and a lease that has
// not yet expired. A late worker whose lease was already reclaimed by another
// worker therefore matches zero rows and cannot overwrite the new owner's
// result. The same guard makes the operation idempotent-safe: a second
// completeJob() with the same token after the first one succeeded finds the
// job in state 'completed' and matches nothing.
//
// Returns one of:
//   { status: 200, job }                          completed
//   { status: 404, code: 'NOT_FOUND' }            no such job
//   { status: 409, code: 'CLAIM_MISMATCH' }       token/state/lease no longer valid
export function completeJob(db, { id, claimToken, result, now }) {
  const complete = db.prepare(`
    UPDATE jobs
       SET state      = 'completed',
           result     = @result,
           error      = NULL,
           updated_at = @updated_at
     WHERE id = @id
       AND claim_token = @claim_token
       AND state = 'running'
       AND lease_until >= @now
  `);

  const run = db.transaction(() => {
    const updated = complete.run({
      id,
      claim_token: claimToken,
      result,
      now,
      updated_at: now,
    });

    if (updated.changes === 1) {
      return { status: 200, job: getJob(db, id) };
    }

    // The UPDATE matched nothing: either the job does not exist, or it is no
    // longer owned by this claim (wrong token, not running, or lease expired).
    const existing = getJob(db, id);
    if (!existing) {
      return { status: 404, code: 'NOT_FOUND' };
    }

    return { status: 409, code: 'CLAIM_MISMATCH' };
  });

  return run();
}

// Fail a job that this worker currently owns.
//
// Like completeJob(), this is a conditional UPDATE guarded by the caller's
// claim_token, state = 'running' and a lease that has not yet expired, so a
// late worker whose lease was already reclaimed cannot overwrite the new
// owner's state.
//
// The difference from completeJob() is the retry policy: when the job still
// has attempts left (attempts < maxAttempts) it goes back to 'queued' so the
// next claimJob() can pick it up again, and the claim_token/lease_until are
// cleared because the job no longer has an owner. When the retry budget is
// exhausted (attempts >= maxAttempts) the job becomes 'failed' and stays
// terminal. In both cases the error message is preserved so the last failure
// reason is visible.
//
// Returns one of:
//   { status: 200, job }                          requeued or failed
//   { status: 404, code: 'NOT_FOUND' }            no such job
//   { status: 409, code: 'CLAIM_MISMATCH' }       token/state/lease no longer valid
export function failJob(db, { id, claimToken, error, now, maxAttempts }) {
  const fail = db.prepare(`
    UPDATE jobs
       SET state       = CASE
                           WHEN attempts < @max_attempts THEN 'queued'
                           ELSE 'failed'
                         END,
           error       = @error,
           claim_token = CASE
                           WHEN attempts < @max_attempts THEN NULL
                           ELSE claim_token
                         END,
           lease_until = CASE
                           WHEN attempts < @max_attempts THEN NULL
                           ELSE lease_until
                         END,
           updated_at  = @updated_at
     WHERE id = @id
       AND claim_token = @claim_token
       AND state = 'running'
       AND lease_until >= @now
  `);

  const run = db.transaction(() => {
    const updated = fail.run({
      id,
      claim_token: claimToken,
      error,
      now,
      max_attempts: maxAttempts,
      updated_at: now,
    });

    if (updated.changes === 1) {
      return { status: 200, job: getJob(db, id) };
    }

    // The UPDATE matched nothing: either the job does not exist, or it is no
    // longer owned by this claim (wrong token, not running, or lease expired).
    const existing = getJob(db, id);
    if (!existing) {
      return { status: 404, code: 'NOT_FOUND' };
    }

    return { status: 409, code: 'CLAIM_MISMATCH' };
  });

  return run();
}

// Expire leases of jobs whose retry budget is exhausted.
//
// A job that is 'running' with an expired lease and attempts >= maxAttempts
// can no longer be claimed (claimJob() requires attempts < maxAttempts), so
// it would otherwise stay 'running' forever. This sweep moves such jobs to
// the terminal 'failed' state with error = 'LEASE_EXPIRED'.
//
// The UPDATE is unconditional with respect to claim_token: the lease has
// already expired, so the previous owner can no longer complete or fail the
// job (both require lease_until >= now), and there is no new owner yet.
// attempts is deliberately not incremented: the retry budget was already
// consumed by the claim that produced this lease.
//
// Returns the number of jobs that were transitioned to 'failed'.
export function expireLeases(db, { now, maxAttempts }) {
  const expire = db.prepare(`
    UPDATE jobs
       SET state      = 'failed',
           error      = 'LEASE_EXPIRED',
           updated_at = @updated_at
     WHERE state = 'running'
       AND lease_until < @now
       AND attempts >= @max_attempts
  `);

  const result = expire.run({
    now,
    max_attempts: maxAttempts,
    updated_at: now,
  });

  return result.changes;
}

// Read a single job by its id.
//
// Returns the job row as a plain object, or null when no job with that id
// exists. Callers (the API) turn the null into a 404; the worker uses the
// same shape when it needs to re-read a job it just claimed.
export function getJob(db, id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ?? null;
}

// Detect a UNIQUE-constraint violation on jobs.idempotency_key.
//
// better-sqlite3 throws a SqliteError with `code === 'SQLITE_CONSTRAINT_UNIQUE'`
// and a message naming the offending column(s). We check both the code and the
// column name so that a future UNIQUE constraint on another column is not
// mistaken for an idempotency conflict.
function isIdempotencyConflict(err) {
  if (!err || err.code !== 'SQLITE_CONSTRAINT_UNIQUE') {
    return false;
  }
  return typeof err.message === 'string' && err.message.includes('idempotency_key');
}
