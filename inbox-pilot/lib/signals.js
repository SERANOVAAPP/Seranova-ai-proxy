import { domainOf } from "./mail-parse.js";

// ── Built-in signal detection ─────────────────────────────────────────
// Recognizes school, work, and high-stakes senders without any AI. These
// are hints, not verdicts: they raise or lower a score that the rules
// engine combines with what it has learned about you.

export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com",
  "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "comcast.net",
  "att.net", "sbcglobal.net", "verizon.net", "cox.net", "charter.net",
]);

// School communication platforms (parent portals, LMS, messaging apps).
const SCHOOL_PLATFORM_DOMAINS = [
  "infinitecampus.com", "infinitecampus.org", "parentsquare.com", "remind.com", "remind101.com",
  "schoology.com", "instructure.com", "powerschool.com", "classdojo.com", "seesaw.me", "skyward.com",
  "schoolmessenger.com", "bloomz.net", "bloomz.com", "konstella.com", "membershiptoolkit.com",
  "schoolcues.com", "finalsite.net", "blackboard.com", "edlio.com", "aeries.net", "aeries.com",
  "classroom.google.com", "k12.com", "myschoolbucks.com", "schoolpay.com", "paypams.com",
  "sportsengine.com", "signupgenius.com", "ptboard.com",
];

const SCHOOL_NAME_RE = /\b(school|elementary|middle school|high school|academy|district|usd|isd|pta|pto|teacher|principal|counselor|attendance|nurse's office|classroom|kindergarten|preschool)\b/i;

const HIGH_STAKES = [
  { kind: "money", re: /\b(bank|credit union|chase|wells fargo|bank of america|citi|capital one|amex|american express|discover|paypal|venmo|zelle|mortgage|loan|invoice|payment (due|failed|declined)|past due|overdue|statement is ready|tax|irs|1099|w-2)\b/i },
  { kind: "legal", re: /\b(attorney|law (firm|office)|legal|court|subpoena|summons|lawsuit|settlement|notary|contract|esq\.?)\b/i },
  { kind: "insurance", re: /\b(insurance|claim (number|status)|policy (number|renewal)|premium|deductible|eob|explanation of benefits)\b/i },
  { kind: "medical", re: /\b(clinic|hospital|medical|doctor|dr\.|pharmacy|prescription|appointment (reminder|confirmation)|lab results|patient portal|mychart|test results|results are available|pediatric|dental|orthodont)\b/i },
  { kind: "government", re: /\b(dmv|department of|county of|city of|social security|passport|jury duty|voter|uscis)\b/i },
];

const DEADLINE_RE = /\b(due (by|on|date)?|deadline|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|end of day|eod)|rsvp|permission slip|sign (and return|by)|action required|response (needed|required)|final notice|expires?|last day)\b/i;

const MARKETING_RE = /\b(\d{1,2}% off|sale|deal|discount|coupon|promo|free shipping|limited time|shop now|new arrivals|exclusive offer|last chance|clearance|black friday|cyber monday|webinar|newsletter|digest|unsubscribe)\b/i;

const NOREPLY_RE = /^(no-?reply|do-?not-?reply|donotreply|notifications?|newsletter|marketing|promo|offers|news|mailer|info|hello|team|updates?)([+.\-_].*)?@/i;

export function isSchoolDomain(domain) {
  if (!domain) return false;
  if (domain.endsWith(".edu") || /(^|\.)k12\./.test(domain) || /\.k12\.[a-z]{2}\.us$/.test(domain)) return true;
  return SCHOOL_PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

export function detectSignals(msg) {
  const email = msg.from.email;
  const domain = domainOf(email);
  const text = `${msg.from.name} ${msg.subject} ${msg.snippet}`;
  const signals = {
    domain,
    school: isSchoolDomain(domain) || SCHOOL_NAME_RE.test(`${msg.from.name} ${msg.subject}`),
    government: domain.endsWith(".gov") || domain.endsWith(".mil"),
    highStakes: HIGH_STAKES.filter((h) => h.re.test(text)).map((h) => h.kind),
    deadline: DEADLINE_RE.test(`${msg.subject} ${msg.snippet}`),
    marketing: MARKETING_RE.test(`${msg.subject} ${msg.snippet}`),
    bulk: Boolean(msg.listUnsubscribe || msg.listId || msg.precedence === "bulk" || msg.precedence === "list"),
    noreply: NOREPLY_RE.test(email),
    automated: Boolean(msg.autoSubmitted && msg.autoSubmitted !== "no"),
    gmailCategory: (msg.labelIds.find((l) => l.startsWith("CATEGORY_")) || "").replace("CATEGORY_", "").toLowerCase(),
    gmailImportant: msg.labelIds.includes("IMPORTANT"),
    starred: msg.labelIds.includes("STARRED"),
    spam: msg.labelIds.includes("SPAM"),
    freeMail: FREE_MAIL_DOMAINS.has(domain),
  };
  if (signals.government) signals.highStakes.push("government");
  signals.highStakes = [...new Set(signals.highStakes)];
  return signals;
}
