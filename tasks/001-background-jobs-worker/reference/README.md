# Jobs API + worker (эталон к ТЗ № 001)

Учебный сервис: API принимает строку, worker считает в ней «слова» (`/\S+/g`). Node.js 22+, Fastify, better-sqlite3, `node:test`.

## Установка и запуск

```bash
npm install
npm run start:api      # PORT=3000, DATABASE_PATH=./data/jobs.sqlite
npm run start:worker   # тот же DATABASE_PATH; WORKER_POLL_MS=500
npm test
```

API и worker — отдельные процессы с общей SQLite (WAL, busy_timeout). Оба корректно завершаются по SIGINT/SIGTERM: API закрывает сервер и БД, worker дорабатывает текущее задание и не берёт новые.

## curl

```bash
curl -i -X POST localhost:3000/jobs -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' -d '{"text":"Hello world"}'     # 201 + Location
curl -i -X POST localhost:3000/jobs -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' -d '{"text":"Hello world"}'     # 200, тот же id
curl localhost:3000/jobs/<id>                                   # state, result.wordCount
curl -X POST localhost:3000/jobs/<id>/cancel                    # 200 / 409
```

Восстановление после рестарта:

```bash
npm run start:api &   # создать задание через POST /jobs
kill -TERM %1         # API остановлен, задание в ./data/jobs.sqlite
npm run start:worker  # worker подхватывает очередь; задание, захваченное
                      # упавшим worker, берётся повторно после истечения lease (10 с)
npm run start:api     # GET /jobs/<id> → completed
```

## Устройство

- `src/jobs.js` — все переходы состояний условными UPDATE. Захват — одна транзакция `BEGIN IMMEDIATE`: сначала задания с истёкшим lease третьей попытки → `failed/LEASE_EXPIRED`, затем `UPDATE … WHERE id=(SELECT … LIMIT 1) RETURNING *`. Обработка идёт вне транзакции. Завершение и ошибка пишутся только при совпадении `claim_token`, `state='running'` и `lease_until > now`.
- Идемпотентность: `INSERT … ON CONFLICT(idempotency_key) DO NOTHING RETURNING *` — уникальность обеспечивает ограничение БД.
- Отмена: `UPDATE … WHERE state='queued'`; в гонке с захватом побеждает ровно один.
- Гарантия — корректный сохранённый итог, не exactly-once: после падения обработка может повториться.
