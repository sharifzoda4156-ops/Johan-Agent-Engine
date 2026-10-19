import http from 'node:http';
import { pathToFileURL } from 'node:url';
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
      send(200, paginate(store.items, { limit, cursor }));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return send(400, { error: { code: 'INVALID_CURSOR', message: 'Invalid cursor' } });
      }
      if (err instanceof InvalidLimitError) {
        return send(400, { error: { code: 'INVALID_LIMIT', message: 'Invalid limit' } });
      }
      send(500, { error: { code: 'INTERNAL', message: 'Internal error' } });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const items = Array.from({ length: 50 }, (_, n) => ({
    id: `item-${String(n).padStart(3, '0')}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  }));
  createServer({ items }).listen(Number(process.env.PORT) || 3000);
}
