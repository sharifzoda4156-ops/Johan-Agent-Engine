# PR: Компонент поля тегов (`src/tagInput.js`)

## Ветка

`feat/tag-input` — отдельная ветка от основной. Merge и deploy не выполняются:
решение о слиянии остаётся за владельцем репозитория.

## Изменено

- `package.json` — пакет `tag-input`: `private: true`, `type: "module"`,
  скрипт `test: "node --test"`, единственная dev-зависимость `jsdom: "^24"`.
- `src/tagInput.js` — реализация компонента: экспорты `normalizeTag`,
  `isValidTag`, `createTagInput(container, options)`; разметка `ul.tags` и
  `input.tag-input`; обработчики `keydown`/`input`/`blur`/`click`;
  `getTags`/`setTags`/`destroy`; валидация с `TypeError` до изменения состояния;
  идемпотентный `destroy()`.
- `test/tagInput.test.js` — тесты на `node:test` + `jsdom`: изоляция JSDOM,
  поведение клавиатуры и ввода, `aria-invalid`, `maxTags`/`disabled`,
  копии в `onChange`/`getTags`, `TypeError` для `initial`/`setTags`, `destroy`.
- `README.md` — раздел «Компонент поля тегов (`src/tagInput.js`)»: установка,
  подключение в HTML, таблица опций, API и поведение.

## Проверено

- `npm install` — установлена единственная dev-зависимость `jsdom`.
- `npm test` (`node --test`) — все тесты зелёные.
- Покрытые сценарии: монтирование в контейнер, `Enter`/`,`/`Backspace`/`blur`,
  ввод с запятыми, клик по `.tag-remove` с возвратом фокуса, лимит `maxTags`,
  нормализация и дедупликация, `TypeError` без изменения состояния,
  идемпотентный `destroy()`.

## Блокеры

- Нет. Merge и deploy намеренно не выполняются.

## PR

- Ветка: `feat/tag-input`.
- Коммит: реализация компонента поля тегов, тесты и документация.
- Ревью: проверить соответствие `README.md` и `src/tagInput.js`, затем слить
  вручную.
