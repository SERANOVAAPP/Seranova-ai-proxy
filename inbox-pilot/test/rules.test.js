import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMessage, mergeVerdicts } from "../lib/rules.js";
import { DEFAULT_PROFILE, teach, entryMatches } from "../lib/profile.js";

const profile = (extra = {}) => ({ ...structuredClone(DEFAULT_PROFILE), ...extra });
const msg = (over = {}) => ({
  id: "1", threadId: "1", accountId: "a",
  from: { name: "Someone", email: "someone@example.org" },
  to: [], cc: [], subject: "Hello", snippet: "", labelIds: ["INBOX"],
  listUnsubscribe: "", listId: "", precedence: "", autoSubmitted: "", body: "", attachments: [],
  ...over,
});

test("people you've written to are important without AI", () => {
  const r = scoreMessage(msg({ from: { name: "Marcus", email: "marcus@bell.com" } }), profile({ correspondents: { "marcus@bell.com": 4 } }));
  assert.equal(r.bucket, "important");
  assert.equal(r.needsAI, false);
  assert.equal(r.certain, true);
});

test("never-miss matches emails, domains, and names", () => {
  const p = profile({ neverMiss: ["@lincoln.k12.ca.us", "Whitfield", "bank@chase.com"] });
  assert.equal(scoreMessage(msg({ from: { name: "Ms A", email: "a@lincoln.k12.ca.us" } }), p).bucket, "important");
  assert.equal(scoreMessage(msg({ from: { name: "Dana Whitfield", email: "d@law.com" } }), p).bucket, "important");
  assert.equal(scoreMessage(msg({ from: { name: "Chase", email: "bank@chase.com" } }), p).reasons[0], "On your never-miss list");
});

test("Gmail spam and always-noise are junk", () => {
  assert.equal(scoreMessage(msg({ labelIds: ["SPAM"] }), profile()).bucket, "junk");
  assert.equal(scoreMessage(msg({ from: { name: "Old Navy", email: "x@oldnavy.com" } }), profile({ alwaysNoise: ["oldnavy.com"] })).bucket, "junk");
});

test("obvious promotions are filed without AI", () => {
  const r = scoreMessage(msg({ subject: "50% off sale ends tonight", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], listUnsubscribe: "<x>", from: { name: "Shop", email: "deals@shop.com" } }), profile());
  assert.equal(r.bucket, "subscriptions");
  assert.equal(r.needsAI, false);
});

test("school portals beat their unsubscribe headers", () => {
  const r = scoreMessage(msg({ from: { name: "ParentSquare", email: "donotreply@parentsquare.com" }, subject: "Permission slip due Friday", listUnsubscribe: "<x>" }), profile());
  assert.notEqual(r.bucket, "subscriptions");
  assert.ok(r.positive);
});

test("teaching a sender becomes a hard override, domain scope covers the domain", () => {
  let p = teach(profile(), { email: "news@acme.com", scope: "domain", bucket: "junk" });
  assert.equal(scoreMessage(msg({ from: { name: "Acme", email: "ceo@acme.com" } }), p).bucket, "junk");
  p = teach(p, { email: "ceo@acme.com", scope: "sender", bucket: "important" });
  assert.equal(scoreMessage(msg({ from: { name: "Acme", email: "ceo@acme.com" } }), p).bucket, "important");
});

test("repeated trashing teaches junk; replying teaches importance", () => {
  const promo = msg({ from: { name: "X", email: "x@y.com" }, listUnsubscribe: "<x>" });
  assert.equal(scoreMessage(promo, profile(), { trash: 3, respond: 0 }).bucket, "junk");
  const r = scoreMessage(msg({ from: { name: "X", email: "x@y.com" } }), profile(), { respond: 2 });
  assert.ok(r.score >= 5);
});

test("mergeVerdicts never silently buries anything with a positive signal", () => {
  const rule = { bucket: "possibly", positive: true };
  assert.equal(mergeVerdicts(rule, { bucket: "subscriptions", confidence: 0.8 }), "possibly");
  assert.equal(mergeVerdicts(rule, { bucket: "subscriptions", confidence: 0.95 }), "subscriptions");
  assert.equal(mergeVerdicts({ bucket: "possibly", positive: false }, { bucket: "junk", confidence: 0.5 }), "possibly");
  assert.equal(mergeVerdicts({ bucket: "possibly", positive: false }, { bucket: "important", confidence: 0.5 }), "possibly");
  assert.equal(mergeVerdicts({ bucket: "subscriptions", positive: true }, null), "possibly");
});

test("entryMatches does whole-word name matching", () => {
  assert.equal(entryMatches("Ann", msg({ from: { name: "Annual Report", email: "r@x.com" } })), false);
  assert.equal(entryMatches("Ann", msg({ from: { name: "Ann Lee", email: "r@x.com" } })), true);
});

test("expiring promo offers are not deadlines", () => {
  const r = scoreMessage(msg({ from: { name: "Sephora", email: "s@beauty.sephora.com" }, subject: "Your points expire soon", snippet: "Shop now", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], listUnsubscribe: "<x>" }), profile());
  assert.equal(r.positive, false);
  assert.equal(r.bucket, "subscriptions");
});
