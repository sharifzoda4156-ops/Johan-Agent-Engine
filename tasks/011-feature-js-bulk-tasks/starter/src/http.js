import http from 'node:http';

const MAX_BODY = 1024 * 1024;

function send(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data);
}

const fail = (res, status, code, extra = {}) => send(res, status, { error: { code, message: code, ...extra } });

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400, code: 'INVALID_JSON' });
  }
}

export function createServer(service) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = /^\/tasks(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return fail(res, 404, 'NOT_FOUND');
    const id = m[1] && decodeURIComponent(m[1]);
    try {
      if (!id && req.method === 'GET') return send(res, 200, { tasks: service.listTasks() });
      if (!id && req.method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'VALIDATION_ERROR', { field: 'body' });
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200) {
          return fail(res, 400, 'VALIDATION_ERROR', { field: 'title' });
        }
        if (body.done !== undefined && typeof body.done !== 'boolean') return fail(res, 400, 'VALIDATION_ERROR', { field: 'done' });
        if (body.priority !== undefined && (!Number.isInteger(body.priority) || body.priority < 1 || body.priority > 5)) {
          return fail(res, 400, 'VALIDATION_ERROR', { field: 'priority' });
        }
        return send(res, 201, service.createTask({ ...body, title: body.title.trim() }));
      }
      if (id && req.method === 'GET') return send(res, 200, service.getTask(id));
      if (id && req.method === 'PATCH') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'VALIDATION_ERROR', { field: 'body' });
        if (body.title !== undefined && (typeof body.title !== 'string' || !body.title)) {
          return fail(res, 400, 'VALIDATION_ERROR', { field: 'title' });
        }
        if (body.done !== undefined && typeof body.done !== 'boolean') return fail(res, 400, 'VALIDATION_ERROR', { field: 'done' });
        if (body.priority !== undefined && !Number.isInteger(body.priority)) return fail(res, 400, 'VALIDATION_ERROR', { field: 'priority' });
        return send(res, 200, service.updateTask(id, body));
      }
      if (id && req.method === 'DELETE') {
        service.deleteTask(id);
        return send(res, 204);
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED');
    } catch (err) {
      if (err.code === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND');
      if (err.status) return fail(res, err.status, err.code);
      console.error(err);
      return fail(res, 500, 'INTERNAL');
    }
  });
}
