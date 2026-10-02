// ── Storage ───────────────────────────────────────────────────────────
// Thin wrapper over Vercel KV (Upstash Redis). When KV credentials are
// not configured (local dev, tests, demo mode) it falls back to an
// in-memory store with the same interface, so nothing else needs to care.
//
// Every key is prefixed "ip:" so this app can share a Redis database
// with other apps without collisions.

const PREFIX = "ip:";

function createMemoryStore() {
  const data = new Map();
  const hash = (key) => {
    if (!data.has(key)) data.set(key, new Map());
    return data.get(key);
  };
  return {
    kind: "memory",
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : null;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async del(key) {
      data.delete(key);
    },
    async hget(key, field) {
      const h = data.get(key);
      return h && h.has(field) ? structuredClone(h.get(field)) : null;
    },
    async hset(key, entries) {
      const h = hash(key);
      for (const [f, v] of Object.entries(entries)) h.set(f, structuredClone(v));
    },
    async hdel(key, ...fields) {
      const h = data.get(key);
      if (h) for (const f of fields) h.delete(f);
    },
    async hgetall(key) {
      const h = data.get(key);
      if (!h || h.size === 0) return {};
      return Object.fromEntries([...h].map(([f, v]) => [f, structuredClone(v)]));
    },
    async lpush(key, value, maxLen) {
      const list = data.get(key) || [];
      list.unshift(structuredClone(value));
      if (maxLen) list.length = Math.min(list.length, maxLen);
      data.set(key, list);
    },
    async lrange(key, start, stop) {
      const list = data.get(key) || [];
      return structuredClone(list.slice(start, stop === -1 ? undefined : stop + 1));
    },
    _reset() {
      data.clear();
    },
  };
}

async function createKvStore() {
  const { kv } = await import("@vercel/kv");
  return {
    kind: "kv",
    get: (key) => kv.get(key),
    set: (key, value) => kv.set(key, value),
    del: (key) => kv.del(key),
    hget: (key, field) => kv.hget(key, field),
    hset: (key, entries) => (Object.keys(entries).length ? kv.hset(key, entries) : null),
    hdel: (key, ...fields) => (fields.length ? kv.hdel(key, ...fields) : null),
    hgetall: async (key) => (await kv.hgetall(key)) || {},
    async lpush(key, value, maxLen) {
      await kv.lpush(key, value);
      if (maxLen) await kv.ltrim(key, 0, maxLen - 1);
    },
    lrange: (key, start, stop) => kv.lrange(key, start, stop),
  };
}

let storePromise = null;

export function getStore() {
  if (!storePromise) {
    storePromise = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
      ? createKvStore()
      : Promise.resolve(createMemoryStore());
  }
  return storePromise;
}

// Tests swap in a fresh memory store between cases.
export function useMemoryStore() {
  const store = createMemoryStore();
  storePromise = Promise.resolve(store);
  return store;
}

export const keys = {
  accounts: `${PREFIX}accounts`, // hash: accountId -> account (tokens encrypted)
  profile: `${PREFIX}profile`, // importance profile + settings
  items: `${PREFIX}items`, // hash: itemId -> triaged email (summary, never the body)
  senderStats: `${PREFIX}senderstats`, // hash: sender -> decision counts (learning loop)
  decisions: `${PREFIX}decisions`, // list: recent user decisions (trust report later)
  run: `${PREFIX}run`, // status of the latest triage run
  sync: (accountId) => `${PREFIX}sync:${accountId}`, // per-account sync cursor
  oauthState: (state) => `${PREFIX}oauth:${state}`,
};
