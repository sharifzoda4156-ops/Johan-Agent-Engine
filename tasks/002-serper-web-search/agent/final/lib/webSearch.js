'use strict';

// Serper (Google Search) endpoint used for web search.
const SERPER_URL = 'https://google.serper.dev/search';

// Hard timeout for a single Serper request.
const SEARCH_TIMEOUT_MS = 5000;

// Usage accounting: web search is its own kind/model, separate from model calls.
const USAGE_KIND = 'web_search';
const USAGE_MODEL = 'serper';

// Per-user rate limit: at most this many Serper calls per rolling minute.
const WEB_SEARCH_RATE_PER_MIN = 10;
const RATE_WINDOW_MS = 60 * 1000;

// Stable code for an exhausted per-user search budget. The server never sends
// display text for it: the client shows its own RU/EN notice by this code
// (chat message meta kind=web_search_limited). The search rate limit stays its
// own, separately configurable check (WEB_SEARCH_RATE_PER_MIN) — the
// daily/monthly token checkLimit in lib/usageLimits.js gates a different
// window and usage kind.
const WEB_SEARCH_RATE_LIMITED_CODE = 'web_search_rate_limited';

// Thrown when SERPER_API_KEY is absent; distinct from an empty result set so
// callers can tell "search is not configured" from "search returned nothing".
class MissingSerperKeyError extends Error {
  constructor(message = 'SERPER_API_KEY is not configured: web search is unavailable') {
    super(message);
    this.name = 'MissingSerperKeyError';
    this.code = 'missing_serper_key';
  }
}

// Core Serper call shared by searchWeb (the public results-only helper) and
// runChatWebSearch (which additionally needs to know whether Serper actually
// answered, so a usage row is written only for completed calls). Returns
// { ok, results }: ok is true only when Serper responded and the body parsed;
// every transport/status/parse failure is logged and yields
// { ok: false, results: [] } so a search problem can't take down the chat. The
// only thrown error is the distinct MissingSerperKeyError when SERPER_API_KEY
// is absent.
async function requestSerper(query, { num = 5 } = {}) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    throw new MissingSerperKeyError();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.error(`[webSearch] Serper request timed out after ${SEARCH_TIMEOUT_MS}ms`);
    } else {
      console.error('[webSearch] Serper request failed:', err && err.message ? err.message : err);
    }
    return { ok: false, results: [] };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.error(`[webSearch] Serper responded with status ${res.status}`);
    return { ok: false, results: [] };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('[webSearch] Serper returned invalid JSON:', err && err.message ? err.message : err);
    return { ok: false, results: [] };
  }

  const organic = data && Array.isArray(data.organic) ? data.organic : [];
  const results = organic.map((item, i) => ({
    title: item && item.title ? item.title : '',
    link: item && item.link ? item.link : '',
    snippet: item && item.snippet ? item.snippet : '',
    position: item && Number.isFinite(item.position) ? item.position : i + 1,
  }));

  // POST-PROCESSING HOOK: normalized Serper results are ready here but not yet
  // returned. Future filters, reranking, deduplication and caching belong at
  // this point. Nothing is implemented here yet.

  return { ok: true, results };
}

// Public low-level helper: unchanged contract — a normalized array of
// { title, link, snippet, position }, [] for any transport/status/parse
// failure, and MissingSerperKeyError when SERPER_API_KEY is absent.
async function searchWeb(query, { num = 5 } = {}) {
  const { results } = await requestSerper(query, { num });
  return results;
}

function positiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function rateLimitPerMin(env = process.env) {
  return positiveInt(env.WEB_SEARCH_RATE_PER_MIN, WEB_SEARCH_RATE_PER_MIN);
}

// Number of completed Serper calls this user made in the rolling 60s window,
// read from the usage table (kind='web_search'). This is the authoritative
// per-user budget: unlike an in-process counter it survives restarts and is
// shared by every worker. The limit comes from WEB_SEARCH_RATE_PER_MIN (again
// via rateLimitPerMin) and falls back to WEB_SEARCH_RATE_PER_MIN's default when
// the env value is absent/invalid. Returns { used, limit }; a missing or
// failing db degrades to used=0 so search bookkeeping can never block the chat
// (same stance as requestSerper).
async function countRecentWebSearches(userId, { db = getDb(), now = Date.now() } = {}) {
  const limit = rateLimitPerMin();
  if (!db || typeof db.countUsageSince !== 'function') {
    return { used: 0, limit };
  }
  try {
    const used = await db.countUsageSince(userId, USAGE_KIND, now - RATE_WINDOW_MS);
    return { used, limit };
  } catch (err) {
    console.error('[webSearch] failed to count search usage:', err && err.message ? err.message : err);
    return { used: 0, limit };
  }
}

// Lazily resolve db so requiring this module never depends on db availability.
function getDb() {
  try {
    return require('../db');
  } catch {
    return null;
  }
}

// Record one Serper call as its own usage line. Search has no token counts, so
// tokensIn/tokensOut are 0 and cost is a flat unit.
async function recordWebSearchUsage({ userId, db = getDb() } = {}) {
  if (!db || typeof db.recordUsage !== 'function') return;
  try {
    await db.recordUsage({
      userId,
      kind: USAGE_KIND,
      model: USAGE_MODEL,
      tokensIn: 0,
      tokensOut: 0,
      cost: 1,
    });
  } catch (err) {
    console.error('[webSearch] failed to record usage:', err && err.message ? err.message : err);
  }
}

// Chat-facing orchestrator: enforce the per-user rate limit before touching
// Serper, swallow every failure as a status and account for each real call.
// Never throws; always resolves to { status, results, limit? }.
async function runChatWebSearch({ userId, query, num = 5 } = {}) {
  // Authoritative per-user budget: completed web_search usage rows over the
  // rolling 60s window (db.countUsageSince, kind='web_search'). Reading the
  // database — not an in-process counter — means the limit survives restarts
  // and holds across workers. A failing db degrades to used=0 (fail-open), so
  // bookkeeping can never block the chat.
  const { used, limit } = await countRecentWebSearches(userId);
  if (used >= limit) {
    return { status: 'rate_limited', results: [], limit, code: WEB_SEARCH_RATE_LIMITED_CODE };
  }

  let outcome;
  try {
    outcome = await requestSerper(query, { num });
  } catch (err) {
    if (err instanceof MissingSerperKeyError || (err && err.code === 'missing_serper_key')) {
      return { status: 'no_key', results: [] };
    }
    console.error('[webSearch] search failed:', err && err.message ? err.message : err);
    return { status: 'error', results: [] };
  }

  // Bill only searches Serper actually answered: a timed-out, non-200 or
  // unparseable response is not a completed call, so it must not write a usage
  // row (kind='web_search') or spend the user's budget. A completed call with
  // an empty organic list is a real call and IS accounted for.
  if (!outcome.ok) {
    return { status: 'error', results: [] };
  }

  await recordWebSearchUsage({ userId });
  return { status: 'ok', results: outcome.results };
}

// Effective web-search toggle for a chat. The per-chat override
// (chats."webSearchEnabled": 1 = on, 0 = off, NULL = inherit) wins over the
// global WEB_SEARCH_ENABLED flag. The global value is read through the canonical
// serverConfig reader (isConfigFlagEnabled), so the flag keeps flowing
// server_config -> process.env via loadConfigIntoEnv() instead of a bare
// process.env read invented here. A missing/undefined override inherits.
// serverConfig is required lazily so this module (like getDb below) never gains
// a hard dependency on db availability at require time.
function webSearchEnabledFor(chat, { env = process.env } = {}) {
  const override = chat ? chat.webSearchEnabled : undefined;
  if (override === 1 || override === true || override === '1') return true;
  if (override === 0 || override === false || override === '0') return false;
  const { isConfigFlagEnabled, WEB_SEARCH_ENABLED_KEY } = require('./serverConfig');
  return isConfigFlagEnabled(WEB_SEARCH_ENABLED_KEY, env);
}

module.exports = {
  SERPER_URL,
  SEARCH_TIMEOUT_MS,
  USAGE_KIND,
  USAGE_MODEL,
  WEB_SEARCH_RATE_PER_MIN,
  WEB_SEARCH_RATE_LIMITED_CODE,
  MissingSerperKeyError,
  searchWeb,
  runChatWebSearch,
  countRecentWebSearches,
  webSearchEnabledFor,
};
