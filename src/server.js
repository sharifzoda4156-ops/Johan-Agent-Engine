import http from 'node:http';
import { paginate, parseLimit, InvalidCursorError, InvalidLimitError } from './paginate.js';

export function createServer(store) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' || url.pathname !== '/items') {
      return send(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    try {
      const limit = parseLimit(url.searchParams.get('limit') ?? undefined);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const result = paginate(store.all(), { limit, cursor });
      return send(200, result);
    } catch (err) {
      if (err instanceof InvalidLimitError) {
        return send(400, { error: { code: 'INVALID_LIMIT', message: err.message } });
      }
      if (err instanceof InvalidCursorError) {
        return send(400, { error: { code: 'INVALID_CURSOR', message: err.message } });
      }
      return send(500, { error: { code: 'INTERNAL', message: 'Internal error' } });
    }
  });
}
