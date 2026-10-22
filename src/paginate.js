export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export class InvalidCursorError extends Error {}
export class InvalidLimitError extends Error {}

export function encodeCursor(item) {
  return Buffer.from(JSON.stringify({ c: item.createdAt, i: item.id })).toString('base64url');
}

export function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('invalid cursor');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.c !== 'string' ||
    typeof parsed.i !== 'string'
  ) {
    throw new InvalidCursorError('invalid cursor');
  }
  return parsed;
}

function compare(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(raw)) {
    throw new InvalidLimitError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_LIMIT) {
    throw new InvalidLimitError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

export function paginate(items, { limit = DEFAULT_LIMIT, cursor } = {}) {
  const size = typeof limit === 'string' ? parseLimit(limit) : limit;
  if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) {
    throw new InvalidLimitError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  let rows = [...items].sort(compare);
  if (cursor != null) {
    const after = decodeCursor(cursor);
    rows = rows.filter(
      (item) => item.createdAt < after.c || (item.createdAt === after.c && item.id < after.i),
    );
  }
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? encodeCursor(page[page.length - 1]) : null;
  return { items: page, nextCursor };
}
