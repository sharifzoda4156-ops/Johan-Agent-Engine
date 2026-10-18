import Fastify from 'fastify';
import { createJobStore, toApi } from './jobs.js';

const MAX_TEXT = 10_000;
// Текст 10 000 code units в JSON-экранировании (\uXXXX) занимает до 60 000 байт.
const BODY_LIMIT = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Задание не найдено');

function parseId(raw) {
  if (!UUID_RE.test(raw)) throw new ApiError(400, 'VALIDATION_ERROR', 'Некорректный UUID задания');
  return raw.toLowerCase();
}

function parseCreate(body, headers) {
  const ok = body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 1 && Object.hasOwn(body, 'text')
    && typeof body.text === 'string';
  if (!ok) throw new ApiError(400, 'VALIDATION_ERROR', 'Тело должно быть JSON-объектом с единственным строковым полем text');
  if (body.text.length > MAX_TEXT) throw new ApiError(400, 'VALIDATION_ERROR', `Поле text длиннее ${MAX_TEXT} символов`);
  const key = headers['idempotency-key'];
  if (key !== undefined && (typeof key !== 'string' || !KEY_RE.test(key))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key: 1–128 символов [A-Za-z0-9._-]');
  }
  return { text: body.text, key: key ?? null };
}

export function buildApp({ db, now = Date.now, logger = false } = {}) {
  const store = createJobStore(db, { now });
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT });
  // Принимаем только JSON: остальные типы Fastify отклонит с 415.
  app.removeContentTypeParser('text/plain');

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = err.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Тело запроса слишком большое' } });
    if (status === 415) return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Ожидается Content-Type: application/json' } });
    if (status >= 400 && status < 500) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный запрос' } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка' } });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } });
  });

  app.post('/jobs', async (req, reply) => {
    const { text, key } = parseCreate(req.body, req.headers);
    const res = store.create(text, key);
    if (res.conflict) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key уже использован с другим text');
    const job = toApi(res.row);
    if (!res.created) return reply.code(200).send(job);
    return reply.code(201).header('Location', `/jobs/${job.id}`).send(job);
  });

  app.get('/jobs/:id', async (req) => {
    const row = store.get(parseId(req.params.id));
    if (!row) throw notFound();
    return toApi(row);
  });

  app.post('/jobs/:id/cancel', async (req) => {
    const res = store.cancel(parseId(req.params.id));
    if (!res) throw notFound();
    if (res.error === 'JOB_ALREADY_STARTED') throw new ApiError(409, res.error, 'Задание уже выполняется');
    if (res.error === 'JOB_TERMINAL') throw new ApiError(409, res.error, 'Задание уже завершено');
    return toApi(res.row);
  });

  return app;
}
