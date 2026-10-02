import { detectSignals } from "./signals.js";
import { entryMatches, overrideFor } from "./profile.js";
import { domainOf } from "./mail-parse.js";

// ── Classification pass (rules) ───────────────────────────────────────
// Cheap, deterministic scoring that runs on every email. Clear-cut cases
// are decided here for free; everything in between is handed to the AI.

export const BUCKETS = ["important", "possibly", "subscriptions", "junk"];

export function scoreMessage(msg, profile, senderStats = null) {
  const s = detectSignals(msg);
  const reasons = [];
  const email = msg.from.email;
  const domain = domainOf(email);
  const decided = (bucket, reason) => ({ bucket, certain: true, needsAI: false, score: null, reasons: [reason], signals: s, positive: bucket === "important" });

  // 1. Hard rules: things you told the app, and Gmail's spam verdict.
  const override = overrideFor(profile, email);
  if (override) return decided(override, `You marked ${override === "important" ? "this sender as always important" : `this sender as ${override}`}`);
  if (profile.neverMiss.some((e) => entryMatches(e, msg))) return decided("important", "On your never-miss list");
  if (s.spam) return decided("junk", "Gmail flagged this as spam");
  if (profile.alwaysNoise.some((e) => entryMatches(e, msg))) return decided("junk", "On your always-noise list");

  // 2. Score.
  let score = 0;
  let positive = false; // any real sign this could matter
  const add = (pts, reason, isPositive = false) => {
    score += pts;
    if (reason) reasons.push(reason);
    if (isPositive) positive = true;
  };

  const wrote = profile.correspondents[email] || 0;
  if (wrote) add(wrote >= 3 ? 7 : 6, `You've written to ${msg.from.name || email} ${wrote === 1 ? "before" : `${wrote} times`}`, true);
  else if (profile.correspondentDomains[domain] >= 2) add(2, `You correspond with people at ${domain}`, true);

  if (profile.workDomains.some((d) => entryMatches(d, msg))) add(4, "From your work domain", true);
  if (s.school) add(4, "School sender", true);
  if (profile.schoolKeywords.some((k) => entryMatches(k, msg) || new RegExp(`\\b${escapeRe(k)}\\b`, "i").test(msg.snippet))) add(5, "Mentions your school or kids", true);
  if (s.highStakes.length) add(3, `Looks ${s.highStakes.join("/")}-related`, true);
  // "Offer expires tonight!" is marketing, not a deadline.
  const promoNoise = s.marketing && (s.bulk || s.gmailCategory === "promotions");
  if (s.deadline && !promoNoise) add(2, "Mentions a deadline or required action", true);
  const topic = profile.urgentTopics.find((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i").test(`${msg.subject} ${msg.snippet}`));
  if (topic) add(4, `Mentions "${topic}"`, true);
  if (s.starred) add(4, "Starred", true);
  if (s.gmailImportant) add(1, null);

  if (senderStats) {
    if (senderStats.respond) add(Math.min(4, senderStats.respond * 2), "You've replied to this sender from the brief", true);
    if (senderStats.important) add(3, null, true);
    const negatives = (senderStats.trash || 0) + (senderStats.junk || 0);
    if (negatives) add(-Math.min(6, negatives * 2), `You've trashed this sender ${negatives}×`);
    if (senderStats.ignore) add(-Math.min(2, senderStats.ignore * 0.5), null);
  }

  if (s.bulk) add(-3, "Mailing list / has unsubscribe link");
  if (s.marketing) add(-3, "Promotional wording");
  if (s.noreply) add(-1, null);
  if (s.automated) add(-1, null);
  const categoryPenalty = { promotions: -4, social: -2, forums: -1, updates: -0.5 }[s.gmailCategory];
  if (categoryPenalty) add(categoryPenalty, s.gmailCategory === "promotions" ? "Gmail filed it under Promotions" : null);
  const looksPersonal = !s.bulk && !s.noreply && !s.automated && !s.gmailCategory;
  if (looksPersonal) add(1, "Written directly to you");

  // 3. Decide, or defer to the AI.
  const trashedOften = senderStats && (senderStats.trash || 0) + (senderStats.junk || 0) >= 3 && !senderStats.respond;
  if (trashedOften && !positive) return { bucket: "junk", certain: false, needsAI: false, score, reasons, signals: s, positive };
  if (score >= 6 && (wrote || s.starred || score >= 8)) return { bucket: "important", certain: Boolean(wrote), needsAI: false, score, reasons, signals: s, positive };
  if (score <= -5 && !positive) return { bucket: "subscriptions", certain: false, needsAI: false, score, reasons, signals: s, positive };
  const provisional = score >= 3 ? "important" : score >= -2 ? "possibly" : "subscriptions";
  return { bucket: provisional, certain: false, needsAI: true, score, reasons, signals: s, positive };
}

// Combine the rules verdict with the AI's opinion. The guiding rule from
// the spec: nothing uncertain is ever silently buried.
export function mergeVerdicts(rule, ai) {
  if (!ai) return rule.bucket === "subscriptions" && rule.positive ? "possibly" : rule.bucket;
  const confident = ai.confidence >= 0.7;
  if (ai.bucket === "important") return confident || rule.positive ? "important" : "possibly";
  if (ai.bucket === "possibly") return "possibly";
  // AI says subscriptions/junk.
  if (rule.positive && ai.confidence < 0.85) return "possibly";
  if (!confident) return "possibly";
  return ai.bucket;
}

function escapeRe(s) {
  return s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
