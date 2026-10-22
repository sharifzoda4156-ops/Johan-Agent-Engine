# Отчёт: fix/cursor-pagination (Task 006 — bugfix JS cursor pagination)

## изменено

- `src/paginate.js` — курсорный tiebreak по `(createdAt, id)`, корректный `nextCursor`, валидация `limit`, `decodeCursor` → `InvalidCursorError`, отсутствие мутации входного массива.
- `src/server.js` — маппинг `InvalidLimitError` → 400 `INVALID_LIMIT`, `InvalidCursorError` → 400 `INVALID_CURSOR`, прочее → 500 `INTERNAL`.
- `test/paginate.test.js` — регрессионные тесты (tiebreak при равном `createdAt`, `nextCursor=null` при кратном `limit`, `parseLimit`/`paginate` на невалидный `limit`, битый курсор, отсутствие мутации).
- `test/server.test.js` — HTTP-проверки: 200-формат `{items, nextCursor}`, 400 `INVALID_LIMIT`, 400 `INVALID_CURSOR`, пагинация через `nextCursor`, 404 `NOT_FOUND`.
- `scripts/branch-and-commit.sh` и npm-скрипт `branch` в `package.json` — ветка `fix/cursor-pagination`, прогон `npm test`, коммит изменений.
- `package.json` — `"type": "module"`, `scripts.test = "node --test"`, `scripts.branch`.

## проверено

- `npm test` (node --test) — зелёный прогон, лог: `/tmp/cursor-pagination-npm-test.log`.
- Ветка: `fix/cursor-pagination`.

## блокеры

- Нет. Merge и deploy не выполнялись.

## PR

- Ветка для PR: `fix/cursor-pagination`; merge/deploy не выполняются.

## причины по каждому из пяти репортов (одной строкой)

1. Cursor tiebreak — фильтр по курсору сравнивал только `createdAt`, поэтому терялись записи с равным `createdAt`; теперь сравнение по паре `(createdAt, id)`.
2. `nextCursor` — вычислялся как `page.length === limit`, что давало лишний курсор на последней странице при кратном `limit`; теперь `rows.length > limit`.
3. `parseLimit` — `Number(raw) || DEFAULT_LIMIT` пропускал `500/abc/0/1.5/-1/10abc`; теперь строгая проверка `/^[0-9]+$/` и диапазона 1..100 с `InvalidLimitError`.
4. `decodeCursor` — невалидный/обрезанный/не-JSON курсор приводил к 500; теперь `try/catch` + проверка полей `c`/`i` с `InvalidCursorError` (HTTP 400 `INVALID_CURSOR`).
5. Мутация входа — `items.sort(compare)` сортировал исходный массив; теперь сортируется копия `[...items]`, входные данные не меняются.
