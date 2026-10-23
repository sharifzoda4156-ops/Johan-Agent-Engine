import Fastify from 'fastify';

export const BODY_LIMIT = 65536;

/**
 * Error that already carries the HTTP status and machine-readable code that
 * should be sent to the client. Later subpoints (validation, UUID checks,
 * cancel semantics) can throw this and rely on the shared errorHandler below
 * to serialize it as { error: { code, message } }.
 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Translate any thrown value into the canonical error payload
 * { status, code, message }. Fastify's built-in errors (body limit,
 * content-type, JSON parse) are mapped to the codes defined in the spec
 * where they can be inferred; everything else falls back to the Fastify
 * statusCode/ code / message.
 */
function normaliseError(err) {
  if (err instanceof HttpError) {
    return { status: err.status, code: err.code, message: err.message };
  }

  // Fastify errors carry a symbolic `code` (FST_ERR_*). Map the ones the spec
  // cares about explicitly so the body-limit / content-type / bad-json cases
  // produce the required status codes.
  switch (err && err.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' };
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid JSON body' };
    default:
      break;
  }

  const status = err && typeof err.statusCode === 'number' ? err.statusCode : 500;
  const code = (err && typeof err.code === 'string' && err.code) || 'INTERNAL_ERROR';
  const message =
    (err && typeof err.message === 'string' && err.message) || 'Internal Server Error';
  return { status, code, message };
}

/**
 * Map a job row (raw DB row or the object returned by repo.toJob) into the
 * public API representation:
 *   { id, state, result, attempts, error }
 *
 * The database stores `result` as a plain number, but the API exposes it as
 * { wordCount: N } once the job completed successfully; `result` stays null
 * while the job has not produced a value (and when it failed).
 *
 * @param {object} row
 * @returns {{ id: string, state: string, result: { wordCount: number }|null, attempts: number, error: string|null }}
 */
export function toJobResponse(row) {
  const result = row && row.result != null ? { wordCount: row.result } : null;
  return {
    id: row.id,
    state: row.state,
    result,
    attempts: row.attempts,
    error: row.error ?? null,
  };
}

/** Maximum accepted length of `text`, in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 10000;

/** Allowed shape of the optional `Idempotency-Key` header (case-sensitive). */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Canonical UUID (any version) accepted in URL path parameters. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validate a UUID path parameter.
 *
 * @param {string} id
 * @returns {string} the validated id
 * @throws {HttpError} 400 VALIDATION_ERROR
 */
function assertUuid(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid job id');
  }
  return id;
}

/**
 * Enforce `Content-Type: application/json` on a request. Fastify may reject
 * unsupported media types before the handler runs, but the check is repeated
 * here so the contract is explicit and testable.
 *
 * @throws {HttpError} 415 UNSUPPORTED_MEDIA_TYPE
 */
function assertJsonContentType(request) {
  const raw = request.headers['content-type'];
  const mime = String(raw ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mime !== 'application/json') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
}

/**
 * Validate the `POST /jobs` payload and extract the repository input.
 *
 * Rules (spec): the body must be a JSON object with exactly the key `text`
 * (a string of 0..10000 UTF-16 code units; empty text is allowed) and the
 * optional `Idempotency-Key` header must match [A-Za-z0-9._-]{1,128}.
 *
 * @returns {{ text: string, idempotencyKey?: string }}
 * @throws {HttpError} 400 VALIDATION_ERROR / 415 UNSUPPORTED_MEDIA_TYPE
 */
function parseCreateJobInput(request) {
  assertJsonContentType(request);

  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Body must be a JSON object');
  }

  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'text') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Body must contain exactly one field: text');
  }
  if (typeof body.text !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Field text must be a string');
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Field text must be at most ${MAX_TEXT_LENGTH} characters`);
  }

  const rawKey = request.headers['idempotency-key'];
  let idempotencyKey;
  if (rawKey !== undefined) {
    const key = String(rawKey);
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Idempotency-Key must match [A-Za-z0-9._-]{1,128}');
    }
    idempotencyKey = key;
  }

  return idempotencyKey === undefined ? { text: body.text } : { text: body.text, idempotencyKey };
}

/**
 * Build the HTTP application. `db` and `repo` are injected so tests can pass
 * an in-memory or temporary-file database with a controlled clock; the same
 * instances are exposed via app.db / app.repo for later routes to use.
 *
 * @param {{ db?: object, repo?: object }} [deps]
 * @returns {import('fastify').FastifyInstance}
 */
export function buildApp({ db, repo } = {}) {
  const app = Fastify({ bodyLimit: BODY_LIMIT });

  app.decorate('db', db);
  app.decorate('repo', repo);

  app.setErrorHandler((err, request, reply) => {
    const { status, code, message } = normaliseError(err);
    if (status >= 500) {
      request.log.error({ err }, 'unhandled request error');
    }
    reply.code(status).send({ error: { code, message } });
  });

  // POST /jobs — create a job (idempotent when Idempotency-Key is supplied).
  app.post('/jobs', (request, reply) => {
    const input = parseCreateJobInput(request);

    let outcome;
    try {
      outcome = app.repo.createJob(input);
    } catch (err) {
      if (err && err.code === 'IDEMPOTENCY_CONFLICT') {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', err.message || 'Idempotency key conflict');
      }
      throw err;
    }

    const { job, reused } = outcome;
    const payload = toJobResponse(job);
    if (reused) {
      return reply.code(200).send(payload);
    }
    return reply.header('location', `/jobs/${job.id}`).code(201).send(payload);
  });

  // GET /jobs/:id — fetch a single job.
  app.get('/jobs/:id', (request, reply) => {
    const id = assertUuid(request.params.id);

    const job = app.repo.getJob(id);
    if (!job) {
      throw new HttpError(404, 'NOT_FOUND', 'Job not found');
    }

    return reply.code(200).send(toJobResponse(job));
  });

  // POST /jobs/:id/cancel — cancel a job that has not started yet.
  app.post('/jobs/:id/cancel', (request, reply) => {
    const id = assertUuid(request.params.id);

    let job;
    try {
      job = app.repo.cancelJob(id);
    } catch (err) {
      switch (err && err.code) {
        case 'NOT_FOUND':
          throw new HttpError(404, 'NOT_FOUND', 'Job not found');
        case 'JOB_ALREADY_STARTED':
          throw new HttpError(409, 'JOB_ALREADY_STARTED', err.message || 'Job already started');
        case 'JOB_TERMINAL':
          throw new HttpError(409, 'JOB_TERMINAL', err.message || 'Job is in a terminal state');
        default:
          throw err;
      }
    }

    if (!job) {
      throw new HttpError(404, 'NOT_FOUND', 'Job not found');
    }

    return reply.code(200).send(toJobResponse(job));
  });

  return app;
}
