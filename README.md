# Johan Agent Engine ,- тестовые задания

Публичный учебный репозиторий для **проверки нашего агента Johan** на небольших самостоятельных проектах. Здесь мы публикуем технические задания и критерии приёмки, а затем оцениваем качество реализации, обработку сбоев, тестирование и подготовленные агентом PR.

## Задания

- [№ 001 — API фоновых заданий + worker](tasks/001-background-jobs-worker.md) — HTTP API, SQLite, конкурентные операции и восстановление после сбоя.

## Установка

```bash
npm install
```

Требуется Node.js >= 22 (см. `engines.node` в `package.json`). Зависимости:
`fastify` (HTTP API) и `better-sqlite3` (файловая SQLite-база).

## Запуск

### API

```bash
npm run start:api
```

Поднимает HTTP-сервер Fastify на порту `PORT` (по умолчанию `3000`) и
использует базу данных по пути `DATABASE_PATH` (по умолчанию
`./data/jobs.sqlite`). Каталог `data/` создаётся автоматически при первом
запуске.

### Worker

```bash
npm run start:worker
```

Запускает фоновый обработчик очереди: он забирает задания из той же базы
`DATABASE_PATH`, считает слова в тексте и сохраняет результат. API и worker
должны указывать на один и тот же файл базы.

### Переменные окружения

| Переменная      | По умолчанию         | Назначение                                   |
| --------------- | -------------------- | -------------------------------------------- |
| `DATABASE_PATH` | `./data/jobs.sqlite` | Путь к файлу SQLite-базы (общий для API и worker) |
| `PORT`          | `3000`               | Порт HTTP-сервера API (целое 1..65535)       |

Пример запуска с явными значениями:

```bash
DATABASE_PATH=./data/jobs.sqlite PORT=3000 npm run start:api
DATABASE_PATH=./data/jobs.sqlite npm run start:worker
```

Пример PM2-конфигурации с обоими процессами лежит в
`ecosystem.config.example.js`.

## Тесты

```bash
npm test
```

Запускает приёмочные тесты (`node --test`) из каталога `test/`: happy path,
идемпотентность, гонка cancel/claim, восстановление после сбоя, ретраи и
истечение lease, а также персистентность и graceful shutdown при рестарте.

## Примеры curl

Все примеры предполагают, что API запущен на `http://localhost:3000`
(`PORT=3000`). Замените порт, если он отличается.

### Создать задание

```bash
curl -i -X POST http://localhost:3000/jobs \
  -H 'Content-Type: application/json' \
  -d '{"text":"one two three four five six"}'
```

Ответ `201 Created` с заголовком `Location: /jobs/<id>`:

```json
{"id":"<id>","state":"queued","result":null,"attempts":0,"error":null}
```

Повторный запрос с тем же заголовком `Idempotency-Key` и тем же текстом
вернёт `200 OK` с тем же `id`; тот же ключ с другим текстом — `409` с
`{"error":{"code":"IDEMPOTENCY_CONFLICT"}}`:

```bash
curl -i -X POST http://localhost:3000/jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-key-1' \
  -d '{"text":"one two three four five six"}'
```

### Получить задание

```bash
curl -i http://localhost:3000/jobs/<id>
```

Пока worker не обработал задание, `state` равен `queued`; после обработки —
`completed` с результатом:

```json
{"id":"<id>","state":"completed","result":{"wordCount":6},"attempts":1,"error":null}
```

### Отменить задание

```bash
curl -i -X POST http://localhost:3000/jobs/<id>/cancel
```

Для ещё не запущенного задания (`queued`) ответ `200 OK`:

```json
{"id":"<id>","state":"cancelled","result":null,"attempts":0,"error":null}
```

Если задание уже захвачено worker'ом или завершено, ответ `409` с
`{"error":{"code":"JOB_ALREADY_STARTED"}}` или
`{"error":{"code":"JOB_TERMINAL"}}`.

### Восстановление после рестарта worker

Задания и их результаты хранятся в файловой SQLite-базе (`DATABASE_PATH`),
поэтому перезапуск API или worker не теряет данные. Сценарий:

1. Создайте задание (см. выше) и убедитесь, что оно в состоянии `queued`.
2. Остановите worker (Ctrl+C / `SIGTERM`) — он завершит текущий тик и
   корректно закроет базу.
3. Запустите worker снова:

   ```bash
   DATABASE_PATH=./data/jobs.sqlite npm run start:worker
   ```

4. Worker подхватит незавершённые задания из базы и обработает их. Проверьте
   результат:

   ```bash
   curl -i http://localhost:3000/jobs/<id>
   ```

   Ожидается `state: "completed"` и `result: {"wordCount": N}`.

Если worker был остановлен уже после захвата задания, но до сохранения
результата, его lease истечёт (`LEASE_MS`), и задание будет перехвачено
повторно — с сохранением бюджета попыток (`MAX_ATTEMPTS`). Задания, у которых
бюджет попыток исчерпан, переходят в `failed` с `error: "LEASE_EXPIRED"`.

## Принципы

Это **тестовый полигон**, не production-код Johan. Никаких production-интеграций, пользовательских данных и секретов. Реализацию задач агент готовит в отдельных ветках и PR; merge и deploy остаются за владельцем.

**Статус:** опубликовано первое ТЗ. Реализация не запускалась.
