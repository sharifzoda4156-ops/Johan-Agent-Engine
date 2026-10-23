// Курсорная пагинация ленты: новые сверху (createdAt desc, при равенстве id desc).

export class InvalidCursorError extends Error {}
export class InvalidLimitError extends Error {}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function encodeCursor(item) {
  return Buffer.from(JSON.stringify({ c: item.createdAt, i: item.id })).toString('base64url');
}

export function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError(`invalid cursor: ${cursor}`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.c !== 'string' ||
    typeof parsed.i !== 'string'
  ) {
    throw new InvalidCursorError(`invalid cursor: ${cursor}`);
  }
  return parsed;
}

function compare(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
    throw new InvalidLimitError(`invalid limit: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new InvalidLimitError(`limit out of range: ${raw}`);
  }
  return value;
}

export function paginate(items, { limit = DEFAULT_LIMIT, cursor } = {}) {
  let rows = [...items].sort(compare);
  if (cursor !== undefined) {
    const after = decodeCursor(cursor);
    rows = rows.filter(
      (item) => item.createdAt < after.c || (item.createdAt === after.c && item.id < after.i),
    );
  }
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  return { items: page, nextCursor };
}
