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

## Замеры

Задания 003–007 — набор для регулярного замера движка: после каждого этапа доработки одни и те же ТЗ прогоняются заново и сравниваются три числа: доля решённых задач, $ на задачу и время на задачу. Задача считается решённой, если проходят скрытые приёмочные тесты; агент их не видит. Эталонные решения и скрытые тесты хранятся вне этого репозитория. Для `starter/`-заданий агент копирует стартовый код в корень своего рабочего репозитория.

## Протокол: version и ETag

Каждая заметка имеет целочисленное поле `version`, которое начинается с `1` при создании (`POST /notes`) и увеличивается на `1` при каждом успешном обновлении (`PUT /notes/:id`). Поле возвращается в теле заметки вместе с `id`, `title`, `body` и `updatedAt`.

На основе `version` формируется сильный `ETag` в формате `"<version>"` — значение версии в двойных кавычках, например `"1"` или `"2"`. Заголовок `ETag` возвращается в ответах `POST /notes` (201), `GET /notes/:id` (200 и 304) и `PUT /notes/:id` (200), а также в ответах `412` с текущей версией заметки.

Клиенты используют этот тег для условных запросов:

- `If-None-Match` в `GET /notes/:id` — если тег совпадает с текущим `ETag` (в том числе `*` или слабый тег вида `W/"1"`), сервер отвечает `304 Not Modified` с пустым телом и заголовком `ETag`; иначе `200` с телом заметки.
- `If-Match` в `PUT /notes/:id` и `DELETE /notes/:id` — обязателен: без него сервер отвечает `428 Precondition Required`. Если тег не совпадает с текущим `ETag` (слабые теги вида `W/"1"` не совпадают никогда), сервер отвечает `412 Precondition Failed` с заголовком `ETag` текущей версии. Значение `*` совпадает с любой существующей заметкой.

### Примеры curl

Создание заметки — `201` с `ETag: "1"`:

```bash
curl -i -X POST http://localhost:3000/notes \
  -H 'content-type: application/json' \
  -d '{"title":"hello","body":"world"}'
# HTTP/1.1 201 Created
# location: /notes/<id>
# ETag: "1"
# {"id":"<id>","title":"hello","body":"world","version":1,"updatedAt":"..."}
```

Условный `GET` с `If-None-Match` — `304` без тела, если версия не изменилась:

```bash
curl -i http://localhost:3000/notes/<id> -H 'If-None-Match: "1"'
# HTTP/1.1 304 Not Modified
# ETag: "1"

curl -i http://localhost:3000/notes/<id> -H 'If-None-Match: W/"1"'
# HTTP/1.1 304 Not Modified
# ETag: "1"

curl -i http://localhost:3000/notes/<id> -H 'If-None-Match: *'
# HTTP/1.1 304 Not Modified
# ETag: "1"

curl -i http://localhost:3000/notes/<id> -H 'If-None-Match: "2"'
# HTTP/1.1 200 OK
# ETag: "1"
# {"id":"<id>","title":"hello","body":"world","version":1,"updatedAt":"..."}
```

Обновление с `If-Match` — `200` и новая версия `"2"`:

```bash
curl -i -X PUT http://localhost:3000/notes/<id> \
  -H 'content-type: application/json' \
  -H 'If-Match: "1"' \
  -d '{"title":"hello","body":"updated"}'
# HTTP/1.1 200 OK
# ETag: "2"
# {"id":"<id>","title":"hello","body":"updated","version":2,"updatedAt":"..."}
```

Устаревший `If-Match` — `412` с текущим `ETag`:

```bash
curl -i -X PUT http://localhost:3000/notes/<id> \
  -H 'content-type: application/json' \
  -H 'If-Match: "1"' \
  -d '{"title":"hello","body":"stale"}'
# HTTP/1.1 412 Precondition Failed
# ETag: "2"
# {"error":{"code":"PRECONDITION_FAILED","message":"Precondition failed"}}
```

Слабый тег в `If-Match` не совпадает никогда — `412`:

```bash
curl -i -X PUT http://localhost:3000/notes/<id> \
  -H 'content-type: application/json' \
  -H 'If-Match: W/"2"' \
  -d '{"title":"hello","body":"weak"}'
# HTTP/1.1 412 Precondition Failed
# ETag: "2"
```

Отсутствие `If-Match` — `428`:

```bash
curl -i -X PUT http://localhost:3000/notes/<id> \
  -H 'content-type: application/json' \
  -d '{"title":"hello","body":"no-precondition"}'
# HTTP/1.1 428 Precondition Required
# {"error":{"code":"PRECONDITION_REQUIRED","message":"If-Match required"}}
```

Удаление с `If-Match` — `204` без тела:

```bash
curl -i -X DELETE http://localhost:3000/notes/<id> -H 'If-Match: "2"'
# HTTP/1.1 204 No Content

curl -i -X DELETE http://localhost:3000/notes/<id> -H 'If-Match: "1"'
# HTTP/1.1 412 Precondition Failed
# ETag: "2"

curl -i -X DELETE http://localhost:3000/notes/<id>
# HTTP/1.1 428 Precondition Required
# {"error":{"code":"PRECONDITION_REQUIRED","message":"If-Match required"}}
```

## Принципы

Это **тестовый полигон**, не production-код Johan. Никаких production-интеграций, пользовательских данных и секретов. Реализацию задач агент готовит в отдельных ветках и PR; merge и deploy остаются за владельцем.

**Статус:** опубликованы ТЗ 001–007. Прогоны агента на 003–007 не запускались.
