import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupFakeWorld } from "./helpers.js";
import { runTriage } from "../lib/triage.js";
import { getBrief, applyAction, teachSender, getCleanup, getOriginal } from "../lib/brief.js";
import { loadProfile, saveProfile, analyzeSentMail, mergeCorrespondents, applyProfileEdits } from "../lib/profile.js";
import { getStore, keys } from "../lib/store.js";

let world;
beforeEach(async () => {
  world = await setupFakeWorld();
  // Onboarding: sent-mail analysis + interview answers.
  const found = await analyzeSentMail(world.gmail);
  let profile = mergeCorrespondents(await loadProfile(), found);
  profile = applyProfileEdits(profile, { ownerName: "Kaye", workDomains: ["seranovamedspa.com"], schoolKeywords: ["Lincoln", "Mia"], urgentTopics: ["lease"], onboarded: true });
  await saveProfile(profile);
});

const ids = (list) => list.map((it) => it.gmailId).sort();

test("sent-mail analysis finds the people Kaye writes to", async () => {
  const profile = await loadProfile();
  assert.equal(profile.correspondents["priya.shah@gmail.com"], 2);
  assert.equal(profile.correspondents["marcus@bellconstruction.com"], 2);
  assert.ok(profile.correspondents["dwhitfield@whitfieldlaw.com"]);
  assert.equal(profile.correspondents["kaye@example.com"], undefined, "never counts yourself");
  assert.equal(profile.correspondentDomains["gmail.com"], undefined, "free-mail domains are not trusted wholesale");
});

test("a triage run sorts the inbox into the four buckets", async () => {
  const status = await runTriage({ reason: "test" });
  assert.equal(status.state, "done");
  assert.equal(status.counts.scanned, 20);
  const brief = await getBrief();
  const important = ids(brief.important);
  for (const id of ["m01", "m03", "m05", "m13"]) assert.ok(important.includes(id), `${id} should be important, got ${important}`);
  const shown = [...important, ...ids(brief.possibly)];
  for (const id of ["m02", "m04", "m14", "m20"]) assert.ok(shown.includes(id), `${id} must reach the brief`);
  for (const id of ["m06", "m07", "m08", "m09", "m11"]) assert.ok(!shown.includes(id), `${id} must not be in the brief`);
  assert.ok(brief.counts.subscriptions >= 5);
  assert.equal(brief.counts.junk, 1, "only the Gmail-spam message is junk");
  const slip = brief.important.find((it) => it.gmailId === "m01");
  assert.ok(slip.summary.includes("permission slip"));
  assert.ok(brief.deadlines.length > 0);
});

test("stored items never contain email bodies", async () => {
  await runTriage();
  const store = await getStore();
  const raw = JSON.stringify(await store.hgetall(keys.items));
  assert.ok(!raw.includes("Natural History Museum and"), "body text leaked");
  for (const it of Object.values(await store.hgetall(keys.items))) {
    assert.equal(it.body, undefined);
    assert.equal(it.snippet, undefined);
  }
});

test("second run only processes new mail", async () => {
  await runTriage();
  const second = await runTriage();
  assert.equal(second.counts.scanned, 0);
});

test("respond / ignore / trash / undo", async () => {
  await runTriage();
  let brief = await getBrief();
  const [a, b, c] = brief.important;
  await applyAction(a.id, "respond");
  await applyAction(b.id, "ignore");
  await applyAction(c.id, "trash");
  assert.deepEqual(world.gmail.calls.trash, [c.gmailId]);
  brief = await getBrief();
  assert.equal(brief.respondQueue.length, 1);
  assert.ok(!brief.important.some((it) => [a.id, b.id, c.id].includes(it.id)));
  await applyAction(c.id, "undo");
  assert.deepEqual(world.gmail.calls.untrash, [c.gmailId]);
  assert.ok((await getBrief()).important.some((it) => it.id === c.id));
  const stats = await (await getStore()).hgetall(keys.senderStats);
  assert.equal(stats[a.from.email].respond, 1);
});

test("teaching re-files open items from that sender and future mail", async () => {
  await runTriage();
  const before = await getBrief();
  const dental = [...before.important, ...before.possibly].find((it) => it.gmailId === "m14");
  await teachSender(dental.id, { bucket: "junk", scope: "domain" });
  const after = await getBrief();
  assert.ok(![...after.important, ...after.possibly].some((it) => it.gmailId === "m14"));
  assert.equal((await loadProfile()).overrides["@brightsmilesdental.com"], "junk");
});

test("cleanup groups junk and subscriptions by sender", async () => {
  await runTriage();
  const cleanup = await getCleanup();
  const navy = cleanup.groups.find((g) => g.sender === "oldnavy@email.oldnavy.com");
  assert.equal(navy.count, 3);
  assert.equal(cleanup.groups[0].sender, navy.sender, "biggest sender first");
});

test("original email is fetched live", async () => {
  await runTriage();
  const it = (await getBrief()).important.find((x) => x.gmailId === "m05");
  const original = await getOriginal(it.id);
  assert.match(original.body, /CAM cap/);
  assert.deepEqual(original.attachments, ["Lease-Amendment-v2.pdf"]);
});

test("newer message in a thread supersedes the older brief entry", async () => {
  await runTriage();
  const store = await getStore();
  // Simulate a follow-up in Marcus's thread arriving later.
  const { buildMailbox } = await import("../dev/fake-mailbox.js");
  const followUp = structuredClone(world.mailbox.find((m) => m.id === "m03"));
  followUp.id = "m03b";
  followUp.internalDate = String(Date.now() + 1000);
  world.mailbox.push(followUp);
  await runTriage({ now: Date.now() + 2000 });
  const items = Object.values(await store.hgetall(keys.items)).filter((it) => it.threadId === "t03");
  assert.deepEqual(items.map((it) => [it.gmailId, it.status]).sort(), [["m03", "superseded"], ["m03b", "new"]]);
  assert.ok(buildMailbox);
});
