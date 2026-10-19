// Курсорная пагинация ленты: новые сверху (createdAt desc, при равенстве id desc).

export class InvalidCursorError extends Error {}
export class InvalidLimitError extends Error {}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function encodeCursor(item) {
  return Buffer.from(JSON.stringify({ c: item.createdAt, i: item.id })).toString('base64url');
}

export function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

function compare(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  return Number(raw) || DEFAULT_LIMIT;
}

export function paginate(items, { limit = DEFAULT_LIMIT, cursor } = {}) {
  let rows = items.sort(compare);
  if (cursor) {
    const after = decodeCursor(cursor);
    rows = rows.filter((item) => item.createdAt < after.c);
  }
  const page = rows.slice(0, limit);
  const nextCursor = page.length === limit ? encodeCursor(page[page.length - 1]) : null;
  return { items: page, nextCursor };
}
