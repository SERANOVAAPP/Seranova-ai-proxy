import { getStore, keys } from "./store.js";
import { listAccounts, publicAccount, getAccount } from "./accounts.js";
import { getRunStatus } from "./triage.js";
import { providers } from "./providers.js";
import { loadProfile, saveProfile, teach, recordDecision } from "./profile.js";
import { HttpError } from "./http.js";

// ── Daily brief, actions, and cleanup views ───────────────────────────

const URGENCY_RANK = { today: 0, this_week: 1, whenever: 2, none: 3 };

export async function getBrief() {
  const store = await getStore();
  const [items, accounts, run, profile] = await Promise.all([store.hgetall(keys.items), listAccounts(), getRunStatus(), loadProfile()]);
  const all = Object.values(items);
  const open = all.filter((it) => it.status === "new");
  const byPriority = (a, b) =>
    (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3) || Number(b.needsReply) - Number(a.needsReply) || b.date - a.date;

  const deadlines = all
    .filter((it) => (it.status === "new" || it.status === "respond") && it.deadlines?.length)
    .flatMap((it) => it.deadlines.map((d) => ({ ...d, itemId: it.id, from: it.from.name || it.from.email, accountId: it.accountId })))
    .sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));

  return {
    accounts: accounts.map(publicAccount),
    run,
    profile: { onboarded: profile.onboarded, ownerName: profile.ownerName, briefTime: profile.briefTime, timezone: profile.timezone },
    important: open.filter((it) => it.bucket === "important").sort(byPriority),
    possibly: open.filter((it) => it.bucket === "possibly").sort(byPriority),
    respondQueue: all.filter((it) => it.status === "respond").sort((a, b) => b.date - a.date),
    deadlines,
    counts: {
      subscriptions: open.filter((it) => it.bucket === "subscriptions").length,
      junk: open.filter((it) => it.bucket === "junk").length,
    },
  };
}

export async function getItem(id) {
  const store = await getStore();
  const item = await store.hget(keys.items, id);
  if (!item) throw new HttpError(404, "Email not found (it may have been cleared from the brief)");
  return item;
}

async function saveItem(item) {
  const store = await getStore();
  await store.hset(keys.items, { [item.id]: item });
  return item;
}

async function gmailForItem(item) {
  const account = await getAccount(item.accountId);
  if (!account) throw new HttpError(409, "The account this email came from is no longer connected");
  return providers.gmailFor(account);
}

// Respond / Ignore / Trash from the brief checkboxes (plus Undo).
export async function applyAction(id, action) {
  const item = await getItem(id);
  const now = Date.now();
  switch (action) {
    case "respond":
      await recordDecision(item, "respond");
      return saveItem({ ...item, status: "respond", actedAt: now });
    case "ignore":
      await recordDecision(item, "ignore");
      return saveItem({ ...item, status: "ignored", actedAt: now });
    case "trash": {
      // Gmail trash keeps mail recoverable for 30 days.
      await (await gmailForItem(item)).trash(item.gmailId);
      await recordDecision(item, "trash");
      return saveItem({ ...item, status: "trashed", actedAt: now });
    }
    case "undo": {
      if (item.status === "trashed") await (await gmailForItem(item)).untrash(item.gmailId);
      return saveItem({ ...item, status: "new", actedAt: null });
    }
    default:
      throw new HttpError(400, `Unknown action "${action}"`);
  }
}

// "Always important" / "Always junk" etc. for a sender or their whole domain.
// Re-files every open item from that sender immediately.
export async function teachSender(id, { bucket, scope = "sender" }) {
  if (bucket !== null && !["important", "possibly", "subscriptions", "junk"].includes(bucket)) throw new HttpError(400, "Invalid bucket");
  const item = await getItem(id);
  const profile = teach(await loadProfile(), { email: item.from.email, scope, bucket });
  await saveProfile(profile);
  if (bucket === "important" || bucket === "junk") await recordDecision(item, bucket);

  const store = await getStore();
  const items = Object.values(await store.hgetall(keys.items));
  const domain = item.from.email.split("@")[1];
  const sameSender = (it) => (scope === "domain" ? it.from.email.endsWith("@" + domain) : it.from.email === item.from.email);
  const updates = {};
  if (bucket) {
    for (const it of items) {
      if (it.status === "new" && sameSender(it) && it.bucket !== bucket) {
        updates[it.id] = { ...it, bucket, reasons: [`You marked this ${scope} as ${bucket}`, ...it.reasons].slice(0, 6) };
      }
    }
  }
  if (Object.keys(updates).length) await store.hset(keys.items, updates);
  return { refiled: Object.keys(updates).length, overrides: profile.overrides };
}

// Read the original email live from Gmail. It is shown, never stored.
export async function getOriginal(id) {
  const item = await getItem(id);
  const msg = await (await gmailForItem(item)).getFull(item.gmailId);
  return {
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    subject: msg.subject,
    date: msg.date,
    body: msg.body || msg.snippet,
    attachments: msg.attachments,
    gmailUrl: `https://mail.google.com/mail/u/${encodeURIComponent((await getAccount(item.accountId)).email)}/#all/${item.threadId}`,
  };
}

// Junk and subscriptions grouped by sender, biggest first.
export async function getCleanup() {
  const store = await getStore();
  const items = Object.values(await store.hgetall(keys.items)).filter((it) => it.status === "new" && (it.bucket === "junk" || it.bucket === "subscriptions"));
  const groups = new Map();
  for (const it of items) {
    const g = groups.get(it.from.email) || { sender: it.from.email, name: it.from.name, bucket: it.bucket, count: 0, accountIds: new Set(), latestSubject: "", latestDate: 0, hasUnsubscribe: false };
    g.count += 1;
    g.accountIds.add(it.accountId);
    g.hasUnsubscribe ||= it.hasUnsubscribe;
    if (it.bucket === "junk") g.bucket = "junk";
    if (it.date > g.latestDate) {
      g.latestDate = it.date;
      g.latestSubject = it.subject;
      g.latestItemId = it.id;
    }
    groups.set(it.from.email, g);
  }
  return {
    total: items.length,
    groups: [...groups.values()].map((g) => ({ ...g, accountIds: [...g.accountIds] })).sort((a, b) => b.count - a.count),
  };
}
