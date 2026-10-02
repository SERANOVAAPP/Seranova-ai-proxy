import { getStore, keys } from "./store.js";
import { domainOf } from "./mail-parse.js";
import { FREE_MAIL_DOMAINS } from "./signals.js";

// ── Importance profile ────────────────────────────────────────────────
// Everything the app knows about what matters to you: interview answers,
// people you write to, and every "always important / always junk" you teach it.

export const DEFAULT_PROFILE = {
  onboarded: false,
  ownerName: "",
  neverMiss: [], // people, orgs, emails, @domains that must never be missed
  alwaysNoise: [], // senders that are always junk
  urgentTopics: [], // keywords that make anything urgent
  workDomains: [], // your business domains
  schoolKeywords: [], // school names, teacher names, kids' names
  briefTime: "07:00",
  timezone: "America/Los_Angeles",
  weekendBrief: true,
  correspondents: {}, // email -> times you've written to them
  correspondentDomains: {}, // non-freemail domain -> count
  sentAnalyzedAt: null,
  overrides: {}, // "jane@x.com" or "@x.com" -> bucket you chose
};

const LIST_FIELDS = ["neverMiss", "alwaysNoise", "urgentTopics", "workDomains", "schoolKeywords"];

export async function loadProfile() {
  const store = await getStore();
  return { ...structuredClone(DEFAULT_PROFILE), ...((await store.get(keys.profile)) || {}) };
}

export async function saveProfile(profile) {
  const store = await getStore();
  await store.set(keys.profile, profile);
  return profile;
}

// Only user-editable settings; learned data is never overwritten from the client.
export function applyProfileEdits(profile, edits) {
  const next = { ...profile };
  for (const f of LIST_FIELDS) {
    if (edits[f] !== undefined) {
      const arr = Array.isArray(edits[f]) ? edits[f] : String(edits[f]).split(/[\n,]/);
      next[f] = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].slice(0, 200);
    }
  }
  if (typeof edits.ownerName === "string") next.ownerName = edits.ownerName.trim().slice(0, 100);
  if (typeof edits.briefTime === "string" && /^\d{2}:\d{2}$/.test(edits.briefTime)) next.briefTime = edits.briefTime;
  if (typeof edits.timezone === "string" && isValidTimezone(edits.timezone)) next.timezone = edits.timezone;
  if (typeof edits.weekendBrief === "boolean") next.weekendBrief = edits.weekendBrief;
  if (typeof edits.onboarded === "boolean") next.onboarded = edits.onboarded;
  return next;
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Does a profile list entry (email, @domain, domain, or name/keyword) match?
export function entryMatches(entry, msg) {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  const email = msg.from.email;
  const domain = domainOf(email);
  if (e.includes("@") && !e.startsWith("@")) return email === e;
  const asDomain = e.startsWith("@") ? e.slice(1) : e;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(asDomain)) return domain === asDomain || domain.endsWith("." + asDomain);
  const haystack = `${msg.from.name} ${msg.subject}`.toLowerCase();
  return new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(haystack);
}

// ── Sent-mail analysis ────────────────────────────────────────────────
// Anyone you have written to matters. Scan the sent folder and count
// recipients. Metadata only: no message bodies are read.
export async function analyzeSentMail(gmail, { max = 1000 } = {}) {
  const ids = await gmail.listMessageIds("in:sent", max);
  const messages = await gmail.getMetadata(ids);
  const self = gmail.account.email.toLowerCase();
  const people = {};
  const domains = {};
  for (const m of messages) {
    for (const r of [...m.to, ...m.cc]) {
      if (!r.email || r.email === self) continue;
      people[r.email] = (people[r.email] || 0) + 1;
      const d = domainOf(r.email);
      if (d && !FREE_MAIL_DOMAINS.has(d)) domains[d] = (domains[d] || 0) + 1;
    }
  }
  return { people, domains, scanned: messages.length };
}

export function mergeCorrespondents(profile, { people, domains }) {
  const next = { ...profile, correspondents: { ...profile.correspondents }, correspondentDomains: { ...profile.correspondentDomains } };
  for (const [e, n] of Object.entries(people)) next.correspondents[e] = Math.max(next.correspondents[e] || 0, n);
  for (const [d, n] of Object.entries(domains)) next.correspondentDomains[d] = Math.max(next.correspondentDomains[d] || 0, n);
  next.sentAnalyzedAt = Date.now();
  return next;
}

// ── Learning loop ─────────────────────────────────────────────────────
// Explicit teaching ("always important" / "always junk") becomes a hard
// override. Everyday actions (respond/ignore/trash) are counted per sender
// and nudge future scores.

export function teach(profile, { email, scope, bucket }) {
  const key = scope === "domain" ? "@" + domainOf(email) : email.toLowerCase();
  const overrides = { ...profile.overrides };
  if (bucket === null) delete overrides[key];
  else overrides[key] = bucket;
  return { ...profile, overrides };
}

export function overrideFor(profile, email) {
  const o = profile.overrides || {};
  return o[email] || o["@" + domainOf(email)] || null;
}

export async function recordDecision(item, action) {
  const store = await getStore();
  const sender = item.from.email;
  const stats = (await store.hget(keys.senderStats, sender)) || { respond: 0, ignore: 0, trash: 0, important: 0, junk: 0 };
  if (stats[action] !== undefined) stats[action] += 1;
  stats.lastAt = Date.now();
  await store.hset(keys.senderStats, { [sender]: stats });
  await store.lpush(keys.decisions, { at: Date.now(), itemId: item.id, sender, bucket: item.bucket, action }, 2000);
}
