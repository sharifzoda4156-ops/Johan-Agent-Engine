//
// HTTP API built on Fastify.
//
// This module exposes `buildServer({ db, now })`, which constructs a Fastify
// instance wired to the jobs layer. The entry point (added in a later step)
// reads configuration, opens the database, and starts listening.
//
// Error contract: every error response has the shape
//
//   { "error": { "code": "CODE", "message": "Description" } }
//
// The body limit is set to 10 000 UTF-16 code units, matching the maximum
// accepted length of the `text` field. Fastify's `bodyLimit` is expressed in
// bytes, so we use the worst-case UTF-8 encoding of a UTF-16 code unit
// (3 bytes) to guarantee that any body within the logical limit is accepted
// and anything larger is rejected with 413.

import { pathToFileURL } from 'node:url';

import Fastify from 'fastify';

import { loadConfig } from './config.js';
import { closeDb, openDb } from './db.js';
import { cancelJob, createJob, getJob } from './jobs.js';

// Maximum length of the `text` field, in UTF-16 code units.
export const MAX_TEXT_LENGTH = 10000;

// Idempotency-Key must be 1..128 characters from [A-Za-z0-9._-].
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// Job IDs are UUIDs (crypto.randomUUID). The route parameter must match this
// shape; anything else is a client error (400 VALIDATION_ERROR), not a 404.
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Worst-case UTF-8 byte length of a single UTF-16 code unit is 3 bytes
// (a lone surrogate encodes to 3 bytes in UTF-8). Using 3 * MAX_TEXT_LENGTH
// as the byte limit ensures we never reject a body that is within the
// logical 10 000 code unit limit.
export const BODY_LIMIT_BYTES = MAX_TEXT_LENGTH * 3;

export function buildServer({ db, now } = {}) {
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
  });

  // Expose the injected dependencies to route handlers via the Fastify
  // instance. `now` defaults to Date.now so callers can override it in tests.
  app.decorate('db', db);
  app.decorate('now', typeof now === 'function' ? now : Date.now);

  // Normalise every error to the documented shape. Fastify's own errors
  // (validation, body limit, unsupported media type) carry a `statusCode`
  // and a `code`; we map them to our error codes and fall back to a generic
  // INTERNAL_ERROR for anything unexpected.
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error.statusCode === 'number' ? error.statusCode : 500;

    let code;
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      code = 'PAYLOAD_TOO_LARGE';
    } else if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      code = 'UNSUPPORTED_MEDIA_TYPE';
    } else if (error.validation) {
      code = 'VALIDATION_ERROR';
    } else if (statusCode === 400) {
      code = 'VALIDATION_ERROR';
    } else if (statusCode === 415) {
      code = 'UNSUPPORTED_MEDIA_TYPE';
    } else if (statusCode === 413) {
      code = 'PAYLOAD_TOO_LARGE';
    } else if (statusCode === 404) {
      code = 'NOT_FOUND';
    } else {
      code = 'INTERNAL_ERROR';
    }

    const message =
      typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : 'Internal Server Error';

    reply.status(statusCode).send({
      error: {
        code,
        message,
      },
    });
  });

  // POST /jobs — create a new job.
  //
  // Validation order matters for the documented error contract:
  //   1. Content-Type must be application/json (else 415).
  //   2. Body must be a JSON object with exactly one field `text` of type
  //      string, length 0..10000 UTF-16 code units (else 400).
  //   3. Idempotency-Key, if present, must match [A-Za-z0-9._-]{1,128}
  //      (else 400).
  app.post('/jobs', async (request, reply) => {
    // 1. Content-Type check. Fastify parses JSON bodies, but we must reject
    //    unsupported media types explicitly with 415.
    const contentType = request.headers['content-type'];
    if (!isJsonContentType(contentType)) {
      return reply.status(415).send({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Content-Type must be application/json',
        },
      });
    }

    // 2. Body validation.
    const body = request.body;
    if (!isValidCreateBody(body)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message:
            'Body must be a JSON object with exactly one field "text" of type string, length 0..10000',
        },
      });
    }

    // 3. Idempotency-Key validation (optional header).
    const rawKey = request.headers['idempotency-key'];
    let idempotencyKey = null;
    if (rawKey !== undefined) {
      // A repeated header arrives as an array; that is not a valid key.
      if (typeof rawKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(rawKey)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'Idempotency-Key must be 1..128 characters from [A-Za-z0-9._-]',
          },
        });
      }
      idempotencyKey = rawKey;
    }

    const result = createJob(app.db, {
      text: body.text,
      idempotencyKey,
      now: app.now(),
    });

    if (result.status === 409) {
      return reply.status(409).send({
        error: {
          code: result.code,
          message: 'A job with this Idempotency-Key already exists',
        },
      });
    }

    const job = result.job;
    if (result.status === 201) {
      reply.header('Location', `/jobs/${job.id}`);
    }
    return reply.status(result.status).send(serializeJob(job));
  });

  // GET /jobs/:id — fetch a single job.
  //
  // The `:id` parameter must be a UUID; a malformed value is a client error
  // (400 VALIDATION_ERROR). A well-formed UUID that does not exist is a 404
  // NOT_FOUND.
  app.get('/jobs/:id', async (request, reply) => {
    const { id } = request.params;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Job id must be a valid UUID',
        },
      });
    }

    const job = getJob(app.db, id);
    if (job === null) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Job not found',
        },
      });
    }

    return reply.status(200).send(serializeJob(job));
  });

  // POST /jobs/:id/cancel — cancel a queued job.
  //
  // The `:id` parameter must be a UUID; a malformed value is a client error
  // (400 VALIDATION_ERROR). A well-formed UUID that does not exist is a 404
  // NOT_FOUND. A job that has already started (running/completed/failed) is a
  // 409 JOB_ALREADY_STARTED; a job in a terminal state (cancelled) is a 409
  // JOB_TERMINAL.
  app.post('/jobs/:id/cancel', async (request, reply) => {
    const { id } = request.params;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Job id must be a valid UUID',
        },
      });
    }

    const result = cancelJob(app.db, id, app.now());

    if (result.status === 404) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Job not found',
        },
      });
    }

    if (result.status === 409) {
      const message =
        result.code === 'JOB_ALREADY_STARTED'
          ? 'Job has already started'
          : 'Job is in a terminal state';
      return reply.status(409).send({
        error: {
          code: result.code,
          message,
        },
      });
    }

    return reply.status(200).send(serializeJob(result.job));
  });

  return app;
}

// Returns true when the Content-Type header denotes JSON. The media type is
// case-insensitive and may carry parameters (e.g. "application/json;
// charset=utf-8").
function isJsonContentType(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

// Returns true when `body` is a plain object with exactly one own field
// `text` whose value is a string of at most MAX_TEXT_LENGTH UTF-16 code
// units. Empty strings are allowed.
function isValidCreateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'text') {
    return false;
  }
  const text = body.text;
  if (typeof text !== 'string') {
    return false;
  }
  return text.length <= MAX_TEXT_LENGTH;
}

// Serialise a job row into the documented response shape. `result` is stored
// as a number (word count) and exposed as {"wordCount": N} once completed.
export function serializeJob(job) {
  return {
    id: job.id,
    state: job.state,
    result: job.result === null || job.result === undefined
      ? null
      : { wordCount: job.result },
    attempts: job.attempts,
    error: job.error ?? null,
  };
}

export default buildServer;

// Entry point. Only runs when this module is executed directly
// (`node src/api.js`), not when it is imported (e.g. by tests).
//
// Reads configuration, opens the database, starts listening on PORT, and
// installs SIGINT/SIGTERM handlers that gracefully close the Fastify server
// and the database connection before exiting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = openDb(config.databasePath);
  const app = buildServer({ db });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'Error while closing HTTP server');
    }
    try {
      closeDb(db);
    } catch (err) {
      app.log.error({ err }, 'Error while closing database');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, 'Failed to start HTTP server');
    closeDb(db);
    process.exit(1);
  }
}
