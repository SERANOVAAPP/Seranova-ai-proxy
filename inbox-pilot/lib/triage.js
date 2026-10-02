import { getStore, keys } from "./store.js";
import { listAccounts, saveAccount } from "./accounts.js";
import { GoogleAuthError } from "./google.js";
import { providers as deps } from "./providers.js";
import { loadProfile } from "./profile.js";
import { scoreMessage, mergeVerdicts } from "./rules.js";
import { chunk, DAY_MS } from "./util.js";

// ── The triage pipeline ───────────────────────────────────────────────
//   fetch new inbox mail (metadata only)  ->  rules pass  ->  AI classify
//   the borderline ones  ->  summarize only what made the brief  ->  save
//
// Written against a `step(name, fn)` helper so the same code runs inside
// an Inngest function (each step retried/checkpointed independently) or
// inline in a single request when Inngest isn't configured.

const INITIAL_LOOKBACK_DAYS = Number(process.env.INITIAL_LOOKBACK_DAYS || 7);
const MAX_PER_RUN = Number(process.env.MAX_EMAILS_PER_RUN || 600);
const CLASSIFY_BATCH = 25;
const SUMMARY_PARALLEL = 4;

const inlineStep = (_name, fn) => fn();

export const itemId = (accountId, gmailId) => `${accountId}:${gmailId}`;

export async function getRunStatus() {
  const store = await getStore();
  return (await store.get(keys.run)) || { state: "never" };
}

async function setRunStatus(status) {
  const store = await getStore();
  await store.set(keys.run, status);
}

export async function runTriage({ reason = "manual", step = inlineStep, now: fixedNow } = {}) {
  const store = await getStore();
  // Inngest re-enters this function once per step, so anything time-based
  // must come from a memoized step to stay stable across re-entries.
  const now = fixedNow ?? (await step("start-time", () => Date.now()));
  const startedAt = now;
  await step("mark-running", () => setRunStatus({ state: "running", reason, startedAt, phase: "Checking for new mail" }));

  try {
    const profile = await step("load-profile", () => loadProfile());
    const accounts = (await listAccounts()).filter((a) => a.status !== "disconnected");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: profile.timezone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

    // 1. Fetch + rules, per account.
    const candidates = [];
    const fetchedAccounts = [];
    for (const account of accounts) {
      const fetched = await step(`fetch-${account.id}`, () => fetchAndScore(account, profile, now));
      if (fetched.error) {
        await saveAccount({ ...account, status: "error", statusMessage: fetched.error });
        continue;
      }
      if (account.status === "error") await saveAccount({ ...account, status: "ok", statusMessage: "" });
      candidates.push(...fetched.messages);
      fetchedAccounts.push({ id: account.id, count: fetched.messages.length });
    }

    // 2. AI classification for the borderline ones.
    const borderline = candidates.filter((c) => c.rule.needsAI);
    const aiVerdicts = {};
    const batches = chunk(borderline, CLASSIFY_BATCH);
    for (let i = 0; i < batches.length; i++) {
      await step(`phase-classify-${i}`, () => setRunStatus({ state: "running", reason, startedAt, phase: `Sorting ${borderline.length} unclear emails` }));
      const batch = batches[i];
      const verdicts = await step(`classify-${i}`, () =>
        deps.ai.classifyBatch(batch.map((c) => ({ ...c.msg, hints: c.rule.reasons })), profile)
      );
      Object.assign(aiVerdicts, verdicts);
    }

    // 3. Final buckets. Junk and subscriptions are saved without any further AI work.
    const sorted = candidates.map((c) => {
      const ai = aiVerdicts[c.msg.id] || null;
      return { ...c, ai, bucket: c.rule.needsAI ? mergeVerdicts(c.rule, ai) : mergeVerdicts(c.rule, null) };
    });
    const quiet = sorted.filter((c) => c.bucket === "subscriptions" || c.bucket === "junk");
    await step("save-quiet", async () => {
      const entries = Object.fromEntries(quiet.map((c) => [c.id, toItem(c, null, now)]));
      await store.hset(keys.items, entries);
    });

    // 4. Summaries, one per thread (the newest message stands for its thread).
    const briefWorthy = latestPerThread(sorted.filter((c) => c.bucket === "important" || c.bucket === "possibly"));
    const accountById = Object.fromEntries(accounts.map((a) => [a.id, a]));
    const groups = chunk(briefWorthy, SUMMARY_PARALLEL);
    let done = 0;
    for (const group of groups) {
      await step(`phase-summ-${done}`, () => setRunStatus({ state: "running", reason, startedAt, phase: `Summarizing ${briefWorthy.length - done} emails` }));
      await Promise.all(group.map((c) => step(`summarize-${c.id}`, () => summarizeAndSave(c, accountById[c.msg.accountId], profile, today, now))));
      done += group.length;
    }

    // 5. Housekeeping. Sync cursors only move once everything above succeeded.
    await step("save-cursors", async () => {
      for (const a of fetchedAccounts) await store.set(keys.sync(a.id), { lastSyncAt: now, lastCount: a.count });
    });
    const pruned = await step("prune", () => pruneItems(now));

    const counts = {
      scanned: candidates.length,
      important: sorted.filter((c) => c.bucket === "important").length,
      possibly: sorted.filter((c) => c.bucket === "possibly").length,
      subscriptions: sorted.filter((c) => c.bucket === "subscriptions").length,
      junk: sorted.filter((c) => c.bucket === "junk").length,
      aiClassified: borderline.length,
      summarized: briefWorthy.length,
      pruned,
    };
    return await step("mark-done", async () => {
      const status = { state: "done", reason, startedAt, finishedAt: Date.now(), counts };
      await setRunStatus(status);
      return status;
    });
  } catch (err) {
    console.error("[triage] run failed:", err);
    await setRunStatus({ state: "failed", reason, startedAt, finishedAt: Date.now(), error: err.message });
    throw err;
  }
}

async function fetchAndScore(account, profile, now) {
  const store = await getStore();
  const gmail = deps.gmailFor(account);
  const sync = (await store.get(keys.sync(account.id))) || {};
  // Overlap by an hour so mail that arrives mid-run isn't missed; already
  // triaged ids are skipped below.
  const query = sync.lastSyncAt
    ? `in:inbox after:${Math.floor((sync.lastSyncAt - 60 * 60 * 1000) / 1000)}`
    : `in:inbox newer_than:${INITIAL_LOOKBACK_DAYS}d`;
  let ids;
  try {
    ids = await gmail.listMessageIds(query, MAX_PER_RUN * 2);
  } catch (err) {
    if (err instanceof GoogleAuthError) return { error: err.message, messages: [] };
    throw err;
  }
  const existing = await store.hgetall(keys.items);
  const fresh = ids.filter((id) => !existing[itemId(account.id, id)]).slice(0, MAX_PER_RUN);
  const metas = await gmail.getMetadata(fresh);
  const senderStats = await store.hgetall(keys.senderStats);
  const messages = metas.map((msg) => ({
    id: itemId(account.id, msg.id),
    msg: { ...msg, body: "" },
    rule: stripSignals(scoreMessage(msg, profile, senderStats[msg.from.email] || null)),
  }));
  return { messages };
}

// Signals are only needed inside scoring; keep step outputs small.
function stripSignals(rule) {
  const { signals, ...rest } = rule;
  return { ...rest, bulk: signals.bulk, deadlineHint: signals.deadline };
}

function latestPerThread(list) {
  const byThread = new Map();
  for (const c of list) {
    const key = `${c.msg.accountId}:${c.msg.threadId}`;
    const prev = byThread.get(key);
    if (!prev || c.msg.date > prev.msg.date) byThread.set(key, c);
  }
  return [...byThread.values()];
}

async function summarizeAndSave(c, account, profile, today, now) {
  const store = await getStore();
  const gmail = deps.gmailFor(account);
  let thread;
  try {
    thread = await gmail.getThread(c.msg.threadId);
  } catch (err) {
    console.error(`[triage] could not load thread ${c.msg.threadId}:`, err.message);
    thread = [c.msg];
  }
  // Only include messages up to (and including) the one being triaged.
  const upTo = thread.findIndex((m) => m.id === c.msg.id);
  const context = upTo >= 0 ? thread.slice(0, upTo + 1) : thread;
  let summary;
  try {
    summary = await deps.ai.summarize(context.length ? context : [c.msg], profile, { today });
  } catch (err) {
    console.error(`[triage] summary failed for ${c.id}:`, err.message);
    summary = null;
  }
  const item = toItem(c, summary, now, context.length);

  // A newer message in a thread replaces the older brief entry.
  const existing = await store.hgetall(keys.items);
  const superseded = {};
  for (const other of Object.values(existing)) {
    if (other.threadId === item.threadId && other.accountId === item.accountId && other.id !== item.id && other.status === "new" && (other.bucket === "important" || other.bucket === "possibly")) {
      superseded[other.id] = { ...other, status: "superseded", actedAt: now };
    }
  }
  await store.hset(keys.items, { ...superseded, [item.id]: item });
  return { id: item.id };
}

// What we keep: sender, subject, verdict, summary. Never the email body.
function toItem(c, summary, now, threadCount = 1) {
  const m = c.msg;
  return {
    id: c.id,
    accountId: m.accountId,
    gmailId: m.id,
    threadId: m.threadId,
    from: m.from,
    subject: m.subject,
    date: m.date,
    bucket: c.bucket,
    ruleScore: c.rule.score,
    reasons: [...c.rule.reasons, ...(c.ai?.reason ? [`AI: ${c.ai.reason}`] : [])].slice(0, 6),
    aiConfidence: c.ai?.confidence ?? null,
    hasUnsubscribe: Boolean(c.rule.bulk),
    needsReply: summary ? summary.needs_reply : Boolean(c.ai?.needs_reply),
    oneLine: summary?.one_line || "",
    summary: summary?.summary || "",
    threadSoFar: summary?.thread_so_far || "",
    replyReason: summary?.reply_reason || "",
    urgency: summary?.urgency || (c.rule.deadlineHint ? "this_week" : "none"),
    deadlines: summary?.deadlines || [],
    threadCount,
    status: "new",
    triagedAt: now,
  };
}

// Forget handled items after 14 days and untouched junk after 45.
async function pruneItems(now) {
  const store = await getStore();
  const items = await store.hgetall(keys.items);
  const stale = Object.values(items).filter((it) =>
    (it.status !== "new" && it.status !== "respond" && now - (it.actedAt || it.triagedAt) > 14 * DAY_MS) ||
    ((it.bucket === "junk" || it.bucket === "subscriptions") && now - it.triagedAt > 45 * DAY_MS)
  );
  if (stale.length) await store.hdel(keys.items, ...stale.map((it) => it.id));
  return stale.length;
}
