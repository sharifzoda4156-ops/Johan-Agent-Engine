"use strict";

/*
 * scripts/web-search-selftest.js
 *
 * Селфтест lib/webSearch.js без реальной сети и без необходимости заводить
 * SERPER_API_KEY: глобальный fetch и модуль db подменяются заглушками.
 *
 * Покрытие подпункта 1:
 *   - нормализация organic ({ title, link, snippet, position });
 *   - нет ключа → MissingSerperKeyError / статус no_key;
 *   - таймаут → [] + console.error;
 *   - не-200 → [] + console.error, через runChatWebSearch → статус error;
 *   - превышение лимита → rate_limited без вызова Serper и без usage;
 *   - успешный вызов → usage { kind:'web_search', model:'serper',
 *     tokensIn:0, tokensOut:0, cost:1 }.
 *
 * Новых зависимостей не добавляется.
 */

const assert = require("assert");

/* ------------------------------------------------------------------ *
 * 1. Заглушка модуля db кладётся в require.cache ДО загрузки
 *    lib/webSearch.js, чтобы recordUsage / countUsageSince внутри
 *    модуля (и в lib/usageLimits.js) шли через неё.
 * ------------------------------------------------------------------ */
const dbPath = require.resolve("../db");

const usageCalls = [];
const countCalls = [];
let recentCount = 0;

const stubDb = {
  async recordUsage(row) {
    usageCalls.push(row);
  },
  async countUsageSince(userId, kind, since) {
    countCalls.push({ userId, kind, since });
    return recentCount;
  },
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: stubDb,
  children: [],
  paths: [],
};

/* ------------------------------------------------------------------ *
 * 2. Заглушка глобального fetch.
 * ------------------------------------------------------------------ */
let fetchCalls = [];
let fetchImpl = async () => {
  throw new Error("fetch stub is not configured");
};

global.fetch = (...args) => {
  fetchCalls.push(args);
  return fetchImpl(...args);
};

/* Теперь модуль видит заглушки. */
const web = require("../lib/webSearch");

/* ------------------------------------------------------------------ *
 * 3. Мелкие хелперы.
 * ------------------------------------------------------------------ */
let passed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}${err ? `: ${err.message}` : ""}`);
  }
}

const savedKey = process.env.SERPER_API_KEY;
function setKey(value) {
  if (value === undefined) delete process.env.SERPER_API_KEY;
  else process.env.SERPER_API_KEY = value;
}

function captureErrors() {
  const calls = [];
  const original = console.error;
  console.error = (...args) => {
    calls.push(args);
  };
  return {
    calls,
    restore() {
      console.error = original;
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function reset() {
  usageCalls.length = 0;
  countCalls.length = 0;
  recentCount = 0;
  fetchCalls = [];
  fetchImpl = async () => {
    throw new Error("fetch stub is not configured");
  };
}

/* ------------------------------------------------------------------ *
 * 4. Тесты.
 * ------------------------------------------------------------------ */
async function main() {
  await test("нормализация organic и запрос к Serper", async () => {
    reset();
    setKey("test-key");
    const organic = [
      { title: "A", link: "https://a.example", snippet: "sa", position: 7 },
      { title: "B", link: "https://b.example", snippet: "sb" },
    ];
    fetchImpl = async () => jsonResponse({ organic });

    const results = await web.searchWeb("hello", { num: 3 });

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].title, "A");
    assert.strictEqual(results[0].link, "https://a.example");
    assert.strictEqual(results[0].snippet, "sa");
    assert.strictEqual(results[0].position, 7);
    assert.strictEqual(results[1].title, "B");
    assert.strictEqual(results[1].position, 2);

    assert.strictEqual(fetchCalls.length, 1);
    const [url, opts] = fetchCalls[0];
    assert.strictEqual(url, web.SERPER_URL);
    assert.strictEqual(opts.method, "POST");
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.q, "hello");
    assert.strictEqual(body.num, 3);
  });

  await test("нет ключа → MissingSerperKeyError и статус no_key", async () => {
    reset();
    setKey(undefined);

    await assert.rejects(
      () => web.searchWeb("q"),
      (err) => err instanceof web.MissingSerperKeyError
    );

    const result = await web.runChatWebSearch({ userId: "u-no-key", query: "q" });
    assert.strictEqual(result.status, "no_key");
    assert.deepStrictEqual(result.results, []);
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(usageCalls.length, 0);
  });

  await test("таймаут → [] и лог", async () => {
    reset();
    setKey("test-key");
    fetchImpl = async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };

    const cap = captureErrors();
    let results;
    try {
      results = await web.searchWeb("q");
    } finally {
      cap.restore();
    }

    assert.deepStrictEqual(results, []);
    assert.ok(cap.calls.length >= 1, "ожидался лог console.error при таймауте");
  });

  await test("не-200 → [] и лог", async () => {
    reset();
    setKey("test-key");
    fetchImpl = async () => jsonResponse("upstream failure", 500);

    const cap = captureErrors();
    let results;
    try {
      results = await web.searchWeb("q");
    } finally {
      cap.restore();
    }

    assert.deepStrictEqual(results, []);
    assert.ok(cap.calls.length >= 1, "ожидался лог console.error при не-200");
  });

  await test("не-200 через runChatWebSearch → статус error без usage", async () => {
    reset();
    setKey("test-key");
    recentCount = 0;
    fetchImpl = async () => jsonResponse("upstream failure", 500);

    const cap = captureErrors();
    let result;
    try {
      result = await web.runChatWebSearch({ userId: "u-error", query: "q" });
    } finally {
      cap.restore();
    }

    assert.strictEqual(result.status, "error");
    assert.deepStrictEqual(result.results, []);
    assert.strictEqual(usageCalls.length, 0);
  });

  await test("превышение лимита → rate_limited без Serper и без usage", async () => {
    reset();
    setKey("test-key");
    recentCount = 1e6;

    const result = await web.runChatWebSearch({ userId: "u-limit", query: "q" });

    assert.strictEqual(result.status, "rate_limited");
    assert.deepStrictEqual(result.results, []);
    assert.strictEqual(typeof result.limit, "number");
    assert.ok(result.limit > 0, "limit должен быть положительным");
    assert.strictEqual(fetchCalls.length, 0, "Serper не должен вызываться при лимите");
    assert.strictEqual(usageCalls.length, 0, "usage не должен писаться при лимите");
  });

  await test("успех → usage kind=web_search, model=serper, tokensIn/Out=0, cost=1", async () => {
    reset();
    setKey("test-key");
    recentCount = 0;
    fetchImpl = async () =>
      jsonResponse({ organic: [{ title: "A", link: "https://a.example", snippet: "s" }] });

    const result = await web.runChatWebSearch({ userId: "u-ok", query: "q" });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.results.length, 1);

    assert.strictEqual(usageCalls.length, 1, "usage пишется ровно один раз на вызов Serper");
    const row = usageCalls[0];
    assert.strictEqual(row.userId, "u-ok");
    assert.strictEqual(row.kind, "web_search");
    assert.strictEqual(row.model, "serper");
    assert.strictEqual(row.tokensIn, 0);
    assert.strictEqual(row.tokensOut, 0);
    assert.strictEqual(row.cost, 1);
    assert.strictEqual(
      (row.tokensIn || 0) + (row.tokensOut || 0),
      0,
      "модельный токен-лимит не затронут"
    );
  });
}

main()
  .catch((err) => {
    failures.push({ name: "main", err });
  })
  .then(() => {
    setKey(savedKey);
    if (failures.length) {
      console.error("");
      console.error(`${failures.length} web-search selftest failure(s)`);
      for (const f of failures) {
        console.error(`- ${f.name}`);
        if (f.err && f.err.stack) console.error(f.err.stack);
      }
      process.exit(1);
    }
    console.log(`\nweb-search selftest: ${passed} passed`);
  });
