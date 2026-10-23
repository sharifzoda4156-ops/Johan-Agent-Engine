# Johan Agent Engine ,- тестовые задания

Публичный учебный репозиторий для **проверки нашего агента Johan** на небольших самостоятельных проектах. Здесь мы публикуем технические задания и критерии приёмки, а затем оцениваем качество реализации, обработку сбоев, тестирование и подготовленные агентом PR.

## Задания

- [№ 001 — API фоновых заданий + worker](tasks/001-background-jobs-worker.md) — HTTP API, SQLite, конкурентные операции и восстановление после сбоя.
- [№ 002 — веб-поиск через Serper](tasks/002-serper-web-search/README.md) — перенос реальной задачи Johan, сравнение с эталоном.
- [№ 003 — Python CLI: балансы из CSV](tasks/003-python-ledger-cli/README.md) — Python с нуля: Decimal, валидация, коды выхода.
- [№ 004 — фронтенд: поле тегов](tasks/004-frontend-tag-input/README.md) — DOM без фреймворка, клавиатура, доступность, очистка.
- [№ 005 — багфикс: TTL-кэш на Python](tasks/005-bugfix-python-ttl-cache/README.md) — пять баг-репортов в чужом коде.
- [№ 006 — багфикс: курсорная пагинация](tasks/006-bugfix-js-cursor-pagination/README.md) — Node.js, пять баг-репортов в чужом коде.
- [№ 007 — ETag и оптимистичные блокировки](tasks/007-feature-etag-notes-api/README.md) — фича в существующем HTTP API.
- [№ 008 — рефакторинг: единое ядро цен](tasks/008-refactor-js-pricing-core/README.md) — Node.js, три модуля в одно ядро без смены API, плюс новый промокод.
- [№ 009 — багфикс: планировщик cron](tasks/009-bugfix-python-cron/README.md) — Python, шесть баг-репортов в плотной чужой логике.
- [№ 010 — миграция схемы SQLite](tasks/010-migration-python-sqlite-notes/README.md) — Python, перенос «грязных» данных атомарно и идемпотентно.
- [№ 011 — пакетные операции через все слои](tasks/011-feature-js-bulk-tasks/README.md) — Node.js: хранилище, сервис, HTTP и SDK, атомарный откат.
- [№ 012 — подписи вебхуков Python + Node.js](tasks/012-python-js-webhook-signatures/README.md) — общий протокол в двух языках, байт в байт.

## Замеры

Задания 003–007 (простой набор) и 008–012 (сложный набор) — для регулярного замера движка: после каждого этапа доработки одни и те же ТЗ прогоняются заново и сравниваются три числа: доля решённых задач, $ на задачу и время на задачу. Задача считается решённой, если проходят скрытые приёмочные тесты; агент их не видит. Эталонные решения и скрытые тесты хранятся вне этого репозитория. Для `starter/`-заданий агент копирует стартовый код в корень своего рабочего репозитория.

## Принципы

Это **тестовый полигон**, не production-код Johan. Никаких production-интеграций, пользовательских данных и секретов. Реализацию задач агент готовит в отдельных ветках и PR; merge и deploy остаются за владельцем.

**Статус:** опубликованы ТЗ 001–012. Прогоны агента на 008–012 не запускались.

## Реализация задания № 001 — API фоновых заданий + worker

Два отдельных процесса на одном хосте, общая SQLite-база (`better-sqlite3`, WAL):

- **API** (`src/api.js`) — Fastify, принимает задания и отдаёт их состояние.
- **worker** (`src/worker.js`) — забирает задания из очереди, считает слова, пишет результат.

### Установка

```bash
npm install
```

Требуется Node.js 22+ (см. `engines.node` в `package.json`). `better-sqlite3` собирается
нативно либо ставится из префилдов.

### Запуск API

```bash
npm run start:api
# эквивалент: node src/api.js
```

API слушает `PORT` (по умолчанию `3000`) на `HOST` (по умолчанию `0.0.0.0`).

### Запуск worker

```bash
npm run start:worker
# эквивалент: node src/worker.js
```

Worker опрашивает очередь каждые 50 мс (`POLL_INTERVAL_MS` в `src/worker.js`), берёт
`queued`-задания и `running`-задания с истёкшим lease, обрабатывает их и сохраняет
результат. API и worker можно запускать в любом порядке и в любом количестве — очередь
сериализуется через SQLite.

### Переменные окружения

| Переменная       | По умолчанию          | Назначение                                             |
| ---------------- | --------------------- | ------------------------------------------------------ |
| `DATABASE_PATH`  | `./data/jobs.sqlite`  | Путь к общей SQLite-базе (каталог создаётся сам)       |
| `PORT`           | `3000`                | Порт HTTP API                                          |
| `HOST`           | `0.0.0.0`             | Адрес привязки HTTP API                                |

Пример:

```bash
DATABASE_PATH=./data/jobs.sqlite PORT=3000 npm run start:api
DATABASE_PATH=./data/jobs.sqlite npm run start:worker
```

### Тесты

```bash
npm test
# эквивалент: node --test
```

Тесты используют временные файловые БД (`os.tmpdir()`), управляемые часы и реальные
дочерние процессы для проверки graceful shutdown.

### Примеры curl

Создать задание (201 + `Location`):

```bash
curl -i -X POST http://localhost:3000/jobs \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-1' \
  -d '{"text":"hello world from the worker"}'
```

Повтор с тем же `idempotency-key` и тем же текстом вернёт 200 и то же задание; другой
текст с тем же ключом — 409 `IDEMPOTENCY_CONFLICT`.

Получить состояние задания:

```bash
curl -s http://localhost:3000/jobs/<id>
# {"id":"...","state":"completed","result":{"wordCount":5},"attempts":1,"error":null}
```

Отменить задание (только пока оно `queued`):

```bash
curl -i -X POST http://localhost:3000/jobs/<id>/cancel
# 200 {"id":"...","state":"cancelled",...}
# 409 JOB_ALREADY_STARTED, если worker уже забрал задание
# 409 JOB_TERMINAL, если задание завершено или упало
```

### Восстановление после рестарта worker

Worker не хранит состояние в памяти: всё лежит в SQLite, поэтому рестарт безопасен.

- Забранное задание получает `state='running'`, `claim_token` и `lease_until = now + 10s`.
- Если worker упал, не успев записать результат, задание остаётся `running` с истёкшим
  lease. После рестарта (или другой живой worker) `claimNext` подхватит его снова и
  увеличит `attempts`.
- Всего допускается 3 попытки (`attempts` 0..3). Когда истекает lease третьей попытки,
  `expireLease` переводит задание в `failed` с `error='LEASE_EXPIRED'` — четвёртого
  захвата не будет.
- Постоянная ошибка обработки: задание возвращается в `queued` до исчерпания попыток,
  затем переходит в `failed` с сохранённой причиной.

Проверить вручную:

```bash
# 1. создать задание
curl -s -X POST http://localhost:3000/jobs \
  -H 'content-type: application/json' -d '{"text":"one two three"}'

# 2. запустить worker, дождаться completed
npm run start:worker

# 3. убить worker (Ctrl-C / SIGTERM) и запустить снова — незавершённые running-задания
#    с истёкшим lease будут подхвачены, attempts увеличится, результат допишется.
```

Graceful shutdown: и API, и worker по `SIGINT`/`SIGTERM` останавливают текущую работу,
закрывают Fastify/цикл и корректно закрывают БД (WAL чекпоинтится), завершаясь с кодом 0.
