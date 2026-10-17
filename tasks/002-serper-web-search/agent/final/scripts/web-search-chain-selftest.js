// Цепочка веб-поиска через настоящий обработчик POST /api/agent/ask и
// PATCH /api/chats/:chatId без сети и без SERPER_API_KEY: HTTP-ответы Serper
// и JAE подменены одним fetch, db — заглушки. Реальных Serper/LLM-вызовов нет.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// db для lib/webSearch.js (лимит и usage) — до первой загрузки модуля.
const usageRows = [];
let recentSearches = 0;
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, children: [], paths: [], exports: {
  async recordUsage(row) { usageRows.push(row); },
  async countUsageSince() { return recentSearches; },
} };
const webSearch = require('../lib/webSearch');

const SERPER_ORGANIC = [
  { title: 'Serper docs', link: 'https://serper.dev/docs', snippet: 'POST /search with X-API-KEY', position: 1 },
  { title: 'Второй', link: 'https://example.com/2', snippet: 'Сниппет два' },
];
let serperCalls, jaeCalls, serperMode;
async function fakeFetch(url, init = {}) {
  if (String(url) === webSearch.SERPER_URL) {
    serperCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (serperMode === 'timeout') {
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
        const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
      }));
    }
    if (serperMode === 'status500') return new Response('upstream down', { status: 500 });
    return new Response(JSON.stringify({ organic: SERPER_ORGANIC }), { status: 200 });
  }
  if (String(url).endsWith('/chat/stream')) {
    jaeCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ t: 'Ответ' }) + '\n' +
      JSON.stringify({ done: true, answer: 'Ответ', tokensIn: 3, tokensOut: 2, cost: 0.01, model: 'm' }) + '\n');
  }
  throw new Error('unexpected network call: ' + url);
}
globalThis.fetch = fakeFetch;
// Таймаут Serper (5 с) сжимается до 5 мс: проверяем настоящий AbortController.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === webSearch.SEARCH_TIMEOUT_MS ? 5 : ms, ...rest);

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const serverRequire = require('module').createRequire(path.resolve(__dirname, '../server.js'));
const closure = (from, to) => {
  const start = server.indexOf(from);
  assert.ok(start >= 0, from);
  return server.slice(start, server.indexOf(to, start));
};

class TenmaLimitError extends Error {
  constructor() { super('limit'); this.code = 'usage_limit'; this.scope = 'daily'; this.tenmaMessage = 'limit'; this.resetAt = 1; }
}
let chat, messages, serverUsage, tariffLimited, canned;
const env = { JAE_URL: 'https://jae.offline.invalid' };
const routeDb = {
  getChatForUser: async () => chat,
  getAgentTaskByMessageId: async () => null, getChatMessageForUser: async () => null,
  getChatContextMessages: async () => [], getChatContextTasks: async () => [],
  getActiveAgentTaskForChat: async () => null, resolveActiveChatRepos: async () => [],
  appendChatMessage: async (m) => { messages.push(m); }, appendChatMessageAgent: async (m) => { messages.push(m); },
  openDiagRun: async () => {}, attachDiagTask: async () => {},
  recordUsage: async (row) => { serverUsage.push(row); }, logAgentError: async () => {}, getVerifiedIntents: async () => [],
};
const policy = require('../lib/conversationContext');
let askHandler;
vm.runInNewContext(closure('app.post("/api/agent/ask",', '// Этап 3, кусок 1 — очередь'), {
  require: (id) => (id === './lib/modelPolicy' ? { ...require('../lib/modelPolicy'), prepare: async () => null } : serverRequire(id)),
  app: { post: (_path, fn) => { askHandler = fn; } }, db: routeDb, console: { log() {}, error() {} },
  crypto: { randomUUID: () => 't-new' },
  diagLog: { newRequestId: () => 'diag-test', safeTitle: require('../lib/diagLog').safeTitle },
  agentAskOptions: require('../lib/agentAskOptions'), contextPolicy: policy,
  chatHistory: { recentTaskContext: async () => [], buildHistory: async (_id, n, opts) => policy.selectContext(opts.messages, n, opts) },
  classifyIntakeWithModel: async () => { throw new Error('paid model forbidden'); },
  intake: { classifyIntake: async () => ({ isCodeTask: false, targetRepos: [] }) },
  taskOps: { isTaskOpCommand: () => false }, mergeIntent: { isMergeCommand: () => false },
  askIntakeUndetermined: { isIntakeUndetermined: () => false }, isSubstantialTask: () => false,
  deliveryIntent: { detectDeliveryMode: () => ({ mode: 'none', reason: 'fixture' }) },
  usageLimits: { TenmaLimitError, checkLimit: async () => { if (tariffLimited) throw new TenmaLimitError(); } },
  process: { env }, keyHygiene: { readEnvKey: () => 'offline' },
  dispatch: async ({ text, userId, deps }) => (canned
    ? { source: 'dispatcher', answer: 'Готовый ответ' }
    : { source: 'jae', answer: await deps.askJae(text, userId) }),
  dispatcherLearning: { learnFromAnswer: async () => null }, askJaeIsCacheable: () => false,
  safeErrText: async () => '', TextDecoder, fetch: fakeFetch,
});

function reset({ chatFlag = null, globalOn = true, key = 'test-serper-key', mode = 'ok' } = {}) {
  chat = { id: 'c', webSearchEnabled: chatFlag };
  messages = []; serverUsage = []; usageRows.length = 0; serperCalls = []; jaeCalls = [];
  recentSearches = 0; tariffLimited = false; canned = false; serperMode = mode;
  if (globalOn) process.env.WEB_SEARCH_ENABLED = '1'; else delete process.env.WEB_SEARCH_ENABLED;
  if (key) process.env.SERPER_API_KEY = key; else delete process.env.SERPER_API_KEY;
  delete process.env.WEB_SEARCH_RATE_PER_MIN;
}
async function ask(body) {
  const res = { statusCode: 200, events: [], status(n) { this.statusCode = n; return this; }, json(v) { this.jsonValue = v; return this; },
    setHeader() {}, flushHeaders() {}, write(v) { this.events.push(JSON.parse(v)); }, end() {} };
  await askHandler({ userId: 'u', body: { chatId: 'c', messageId: 'm', prompt: 'Что нового в Serper API?', ...body } }, res);
  return res;
}
// Объекты из vm-контекста — другой realm: сравниваем через JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));
const persisted = () => plain(messages.find((m) => m.id === 'askreply-m'));
const done = (res) => res.events.find((e) => e.done);
const tokens = (res) => res.events.filter((e) => typeof e.t === 'string').map((e) => e.t).join('');

async function noSearchKeepsGlobe(label) {
  const res = await ask({ webSearch: true });
  assert.equal(jaeCalls.length, 1, label);
  assert.equal(jaeCalls[0].webSearch, true, label + ': globe keeps its own search');
  assert.ok(!String(jaeCalls[0].context || '').includes('Результаты веб-поиска'), label);
  assert.equal(usageRows.length, 0, label + ': no web_search usage');
  return res;
}

const tests = {
  async 'per-chat override wins over the global flag'() {
    const on = { WEB_SEARCH_ENABLED: '1' }, off = {};
    for (const [flag, envValue, expected] of [
      [1, off, true], [true, off, true], ['1', off, true],
      [0, on, false], [false, on, false], ['0', on, false],
      [null, on, true], [undefined, on, true], [null, off, false], [undefined, off, false],
    ]) {
      assert.equal(webSearch.webSearchEnabledFor({ webSearchEnabled: flag }, { env: envValue }), expected, `${flag}/${JSON.stringify(envValue)}`);
    }
    assert.equal(webSearch.webSearchEnabledFor(null, { env: on }), true);
    assert.equal(webSearch.webSearchEnabledFor({}, { env: { WEB_SEARCH_ENABLED: 'true' } }), false, 'only "1" enables');
  },

  async 'Serper results reach the model payload once; globe does not search again'() {
    reset();
    const res = await ask({ webSearch: true });
    assert.equal(serperCalls.length, 1);
    const call = serperCalls[0];
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['X-API-KEY'], 'test-serper-key');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, { q: 'Что нового в Serper API?', num: 5 });
    assert.ok(call.init.signal, 'request is abortable');
    assert.equal(jaeCalls.length, 1);
    const payload = jaeCalls[0];
    assert.equal(payload.webSearch, false, 'no second (OpenRouter) search');
    for (const part of ['Результаты веб-поиска', '1. Serper docs', 'POST /search with X-API-KEY', 'https://serper.dev/docs', '2. Второй', 'https://example.com/2']) {
      assert.ok(payload.context.includes(part), part);
    }
    assert.deepEqual(usageRows, [{ userId: 'u', kind: 'web_search', model: 'serper', tokensIn: 0, tokensOut: 0, cost: 1 }]);
    assert.equal(serverUsage.length, 1, 'model usage is separate');
    assert.equal(serverUsage[0].kind, 'dispatch_fallback');
    assert.equal(tokens(res), 'Ответ');
    assert.equal(done(res).answer, 'Ответ');
    assert.equal(done(res).kind, undefined);
    assert.equal(persisted().meta.kind, undefined);
  },

  async 'without the globe the model gets results and webSearch stays off'() {
    reset();
    await ask({});
    assert.equal(serperCalls.length, 1);
    assert.equal(jaeCalls[0].webSearch, false);
    assert.ok(jaeCalls[0].context.includes('https://serper.dev/docs'));
  },

  async 'chat override 1 enables search while the global flag is off'() {
    reset({ chatFlag: 1, globalOn: false });
    await ask({});
    assert.equal(serperCalls.length, 1);
  },

  async 'search off (chat 0 over global on) makes no Serper call'() {
    reset({ chatFlag: 0, globalOn: true });
    await noSearchKeepsGlobe('chat off');
    assert.equal(serperCalls.length, 0);
    reset({ globalOn: false });
    await noSearchKeepsGlobe('global off');
    assert.equal(serperCalls.length, 0);
  },

  async 'rate limit blocks Serper and returns a stable code, no server text'() {
    reset();
    recentSearches = 10;
    const res = await noSearchKeepsGlobe('rate limited');
    assert.equal(serperCalls.length, 0);
    assert.equal(tokens(res), 'Ответ', 'no Russian notice token in the stream');
    assert.equal(done(res).kind, 'web_search_limited');
    assert.equal(done(res).code, 'web_search_rate_limited');
    assert.deepEqual(persisted().meta, { source: 'jae', type: null, kind: 'web_search_limited', code: 'web_search_rate_limited' });
    assert.equal(persisted().content, 'Ответ');
    process.env.WEB_SEARCH_RATE_PER_MIN = '11';
    serperCalls = []; jaeCalls = []; messages = [];
    await ask({});
    assert.equal(serperCalls.length, 1, 'WEB_SEARCH_RATE_PER_MIN raises the limit');
  },

  async 'tariff limit stops before Serper'() {
    reset();
    tariffLimited = true;
    const res = await ask({});
    assert.equal(serperCalls.length, 0);
    assert.equal(jaeCalls.length, 0);
    assert.equal(done(res).type, 'limit_reached');
  },

  async 'canned dispatcher answer does not spend a search'() {
    reset();
    canned = true;
    const res = await ask({});
    assert.equal(serperCalls.length, 0);
    assert.equal(usageRows.length, 0);
    assert.equal(done(res).answer, 'Готовый ответ');
  },

  async 'missing key: no Serper request, answer as before'() {
    reset({ key: null });
    await noSearchKeepsGlobe('no key');
    assert.equal(serperCalls.length, 0);
  },

  async 'timeout aborts the request and answers without search'() {
    reset({ mode: 'timeout' });
    const res = await noSearchKeepsGlobe('timeout');
    assert.equal(serperCalls.length, 1);
    assert.equal(serperCalls[0].init.signal.aborted, true);
    assert.equal(done(res).answer, 'Ответ');
  },

  async 'non-200 answers without search and without usage'() {
    reset({ mode: 'status500' });
    const res = await noSearchKeepsGlobe('non-200');
    assert.equal(serperCalls.length, 1);
    assert.equal(done(res).kind, undefined);
  },
};

// PATCH /api/chats/:chatId: настоящий маршрут; db — та же семантика, что у
// db.setChatWebSearchEnabled (только свой и не удалённый чат). SQL на живом
// Postgres проверяет scripts/account-isolation-pg-test.js.
const chats = new Map();
const patchCalls = [];
let patchFails = false;
let patchHandler;
vm.runInNewContext(closure('app.patch("/api/chats/:chatId",', 'app.post("/api/chats/:chatId/messages"'), {
  app: { patch: (_path, fn) => { patchHandler = fn; } }, console: { error() {} },
  db: { async setChatWebSearchEnabled(chatId, userId, flag) {
    patchCalls.push([chatId, userId, flag]);
    if (patchFails) throw new Error('db down');
    const row = chats.get(chatId);
    if (!row || row.userId !== userId || row.deleted) return false;
    row.webSearchEnabled = flag;
    return true;
  } },
});
async function patch(chatId, userId, body) {
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
  await patchHandler({ params: { chatId }, userId, body }, res);
  return res;
}
tests['PATCH route: owner, foreign/deleted chat, allowed values'] = async () => {
  chats.set('mine', { userId: 'u', deleted: 0, webSearchEnabled: null });
  chats.set('theirs', { userId: 'other', deleted: 0, webSearchEnabled: null });
  chats.set('gone', { userId: 'u', deleted: 1, webSearchEnabled: null });
  for (const [raw, stored] of [[1, 1], [true, 1], ['1', 1], [0, 0], [false, 0], ['0', 0], [null, null]]) {
    const res = await patch('mine', 'u', { webSearchEnabled: raw });
    assert.equal(res.statusCode, 200, String(raw));
    assert.deepEqual(plain(res.body), { ok: true, webSearchEnabled: stored });
    assert.equal(chats.get('mine').webSearchEnabled, stored);
  }
  patchCalls.length = 0;
  for (const raw of [2, -1, 'yes', 'true', '', [], {}, undefined]) {
    const res = await patch('mine', 'u', { webSearchEnabled: raw });
    assert.equal(res.statusCode, 400, JSON.stringify(raw));
    assert.equal(res.body.code, 'web_search_flag_invalid');
  }
  const missingField = await patch('mine', 'u', {});
  assert.equal(missingField.statusCode, 400);
  assert.equal(missingField.body.code, 'web_search_flag_required');
  assert.equal((await patch('mine', 'u', undefined)).body.code, 'web_search_flag_required');
  assert.equal(patchCalls.length, 0, 'invalid input never reaches the database');
  for (const [chatId, label] of [['theirs', 'foreign'], ['gone', 'deleted'], ['nope', 'missing']]) {
    const res = await patch(chatId, 'u', { webSearchEnabled: 1 });
    assert.equal(res.statusCode, 404, label);
    assert.equal(res.body.code, 'chat_not_found');
  }
  assert.equal(chats.get('theirs').webSearchEnabled, null);
  assert.equal(chats.get('gone').webSearchEnabled, null);
  patchFails = true;
  const failed = await patch('mine', 'u', { webSearchEnabled: 1 });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.code, 'chat_setting_save_failed');
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); } catch (err) { failed++; console.error(`FAIL ${name}: ${err.message}`); }
  }
  if (failed) { process.exitCode = 1; return; }
  console.log(`web-search chain selftest: ${Object.keys(tests).length} passed (offline, no Serper/LLM calls)`);
})();
