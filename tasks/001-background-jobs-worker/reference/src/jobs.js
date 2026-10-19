import { randomUUID } from 'node:crypto';

export const LEASE_MS = 10_000;
export const MAX_ATTEMPTS = 3;

export function toApi(row) {
  return {
    id: row.id,
    state: row.state,
    result: row.result === null ? null : { wordCount: row.result },
    attempts: row.attempts,
    error: row.error,
  };
}

// Слой доступа к jobs: все переходы состояний — условные UPDATE,
// чтобы конкурирующие процессы (API, несколько worker) не перетирали друг друга.
export function createJobStore(db, { now = Date.now } = {}) {
  const st = {
    insert: db.prepare(`
      INSERT INTO jobs (id, text, idempotency_key, state, attempts, created_at, updated_at)
      VALUES (@id, @text, @key, 'queued', 0, @now, @now)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *`),
    byKey: db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?'),
    byId: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    cancel: db.prepare(`
      UPDATE jobs SET state = 'cancelled', updated_at = @now
      WHERE id = @id AND state = 'queued'
      RETURNING *`),
    // Третья попытка с истёкшим lease: failed без четвёртого захвата.
    expireExhausted: db.prepare(`
      UPDATE jobs SET state = 'failed', error = 'LEASE_EXPIRED',
        claim_token = NULL, lease_until = NULL, updated_at = @now
      WHERE state = 'running' AND lease_until <= @now AND attempts >= ${MAX_ATTEMPTS}`),
    claim: db.prepare(`
      UPDATE jobs SET state = 'running', attempts = attempts + 1,
        claim_token = @token, lease_until = @leaseUntil, updated_at = @now
      WHERE id = (
        SELECT id FROM jobs
        WHERE state = 'queued'
           OR (state = 'running' AND lease_until <= @now AND attempts < ${MAX_ATTEMPTS})
        ORDER BY created_at, id
        LIMIT 1)
      RETURNING *`),
    complete: db.prepare(`
      UPDATE jobs SET state = 'completed', result = @result, error = NULL,
        claim_token = NULL, lease_until = NULL, updated_at = @now
      WHERE id = @id AND claim_token = @token AND state = 'running' AND lease_until > @now
      RETURNING *`),
    fail: db.prepare(`
      UPDATE jobs SET
        state = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
        error = @error, claim_token = NULL, lease_until = NULL, updated_at = @now
      WHERE id = @id AND claim_token = @token AND state = 'running' AND lease_until > @now
      RETURNING *`),
  };

  // BEGIN IMMEDIATE: сразу берём write-lock, сериализуя запись между процессами.
  const createTx = db.transaction((text, key) => {
    const row = st.insert.get({ id: randomUUID(), text, key, now: now() });
    if (row) return { created: true, row };
    // Ключ уже занят (ограничение UNIQUE): возвращаем существующее задание.
    const existing = st.byKey.get(key);
    if (existing.text !== text) return { conflict: true, row: existing };
    return { created: false, row: existing };
  });

  const claimTx = db.transaction((leaseMs) => {
    const t = now();
    st.expireExhausted.run({ now: t });
    return st.claim.get({ token: randomUUID(), leaseUntil: t + leaseMs, now: t }) ?? null;
  });

  return {
    create(text, key = null) {
      return createTx.immediate(text, key);
    },
    get(id) {
      return st.byId.get(id) ?? null;
    },
    // { row } — отменено/уже отменено; { error } — код ошибки; null — не найдено.
    cancel(id) {
      const row = st.cancel.get({ id, now: now() });
      if (row) return { row };
      const cur = st.byId.get(id);
      if (!cur) return null;
      if (cur.state === 'cancelled') return { row: cur };
      if (cur.state === 'running') return { error: 'JOB_ALREADY_STARTED', row: cur };
      return { error: 'JOB_TERMINAL', row: cur };
    },
    claim(leaseMs = LEASE_MS) {
      return claimTx.immediate(leaseMs);
    },
    // Возвращают обновлённую строку или null, если claim_token устарел/lease истёк.
    complete(id, token, result) {
      return st.complete.get({ id, token, result, now: now() }) ?? null;
    },
    fail(id, token, error) {
      return st.fail.get({ id, token, error: String(error), now: now() }) ?? null;
    },
    expireExhausted() {
      return st.expireExhausted.run({ now: now() }).changes;
    },
  };
}
