// ── A realistic fake mailbox ──────────────────────────────────────────
// Used by the test suite and by `npm run demo`, so the whole app can be
// exercised without a Google account or an Anthropic key. Messages are in
// Gmail API format so the real parsing code runs on them.

const HOUR = 60 * 60 * 1000;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");

function gmailMessage({ id, threadId, from, to = "Kaye Rivera <kaye@example.com>", subject, body, html, ago, labels = ["INBOX", "UNREAD"], headers = {}, attachments = [] }, now) {
  const hdrs = [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Subject", value: subject },
    { name: "Date", value: new Date(now - ago).toUTCString() },
    ...Object.entries(headers).map(([name, value]) => ({ name, value })),
  ];
  const parts = [];
  if (body) parts.push({ mimeType: "text/plain", filename: "", body: { data: b64(body) } });
  if (html) parts.push({ mimeType: "text/html", filename: "", body: { data: b64(html) } });
  for (const name of attachments) parts.push({ mimeType: "application/pdf", filename: name, body: { attachmentId: "att", size: 1000 } });
  const text = body || html.replace(/<[^>]+>/g, " ");
  return {
    id,
    threadId: threadId || id,
    labelIds: labels,
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 160),
    internalDate: String(now - ago),
    payload: { mimeType: "multipart/alternative", headers: hdrs, parts },
  };
}

const PROMO = { "List-Unsubscribe": "<https://example.com/unsub>, <mailto:unsub@example.com>" };

export function buildMailbox(now = Date.now()) {
  const inbox = [
    { id: "m01", from: "Ms. Alvarez <jalvarez@lincoln.k12.ca.us>", subject: "Field trip permission slip due Friday", ago: 3 * HOUR,
      body: "Hi families,\n\nOur 3rd grade class is visiting the Natural History Museum on Oct 14. Please sign the attached permission slip and return it with $12 by this Friday, October 9. Students without a signed slip will stay at school with another class.\n\nThank you!\nJessica Alvarez" , attachments: ["permission-slip.pdf"] },
    { id: "m02", from: "Lincoln Elementary via ParentSquare <donotreply@parentsquare.com>", subject: "Picture Day is Tuesday", ago: 20 * HOUR, headers: PROMO,
      body: "Picture Day is Tuesday, October 6. Order forms are due the same day. Retakes will be November 3." },
    { id: "m03", from: "Marcus Bell <marcus@bellconstruction.com>", subject: "Re: Q4 med spa renovation timeline", threadId: "t03", ago: 5 * HOUR,
      body: "Kaye,\n\nWe can start demo on the treatment rooms Oct 19 if you approve the revised quote by Wednesday. The new total is $18,400 (up $1,200 because of the electrical work). Can you confirm?\n\nMarcus" },
    { id: "m04", from: "Chase <no.reply.alerts@chase.com>", subject: "Your payment of $2,340.00 is due Oct 15", ago: 9 * HOUR,
      body: "Your credit card statement is ready. Minimum payment due: $85.00. Statement balance: $2,340.00. Payment due date: 10/15/2026." },
    { id: "m05", from: "Dana Whitfield, Esq. <dwhitfield@whitfieldlaw.com>", subject: "Lease amendment for your review", ago: 26 * HOUR,
      body: "Hi Kaye,\n\nAttached is the landlord's proposed lease amendment for suite 200. Two items need your decision before I respond: the CAM cap and the renewal option. Their counsel wants an answer by October 12.\n\nBest,\nDana", attachments: ["Lease-Amendment-v2.pdf"] },
    { id: "m06", from: "Old Navy <oldnavy@email.oldnavy.com>", subject: "🔥 50% off EVERYTHING ends tonight", ago: 2 * HOUR, labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], headers: PROMO,
      html: "<p>Shop now! 50% off everything. Free shipping on $50+. Limited time.</p>" },
    { id: "m07", from: "Old Navy <oldnavy@email.oldnavy.com>", subject: "New arrivals just dropped", ago: 30 * HOUR, labels: ["INBOX", "CATEGORY_PROMOTIONS"], headers: PROMO,
      html: "<p>New arrivals for fall. Shop now.</p>" },
    { id: "m08", from: "Old Navy <oldnavy@email.oldnavy.com>", subject: "Your cart misses you", ago: 50 * HOUR, labels: ["INBOX", "CATEGORY_PROMOTIONS"], headers: PROMO,
      html: "<p>Still thinking it over? Complete your order today and get free shipping.</p>" },
    { id: "m09", from: "Target <target@em.target.com>", subject: "Deals picked for you", ago: 8 * HOUR, labels: ["INBOX", "CATEGORY_PROMOTIONS"], headers: PROMO,
      html: "<p>Weekly deals: save 20% on home essentials. Shop now.</p>" },
    { id: "m10", from: "Morning Brew <crew@morningbrew.com>", subject: "☕ The market had a day", ago: 6 * HOUR, labels: ["INBOX", "CATEGORY_UPDATES"], headers: { ...PROMO, "List-Id": "morningbrew.com" },
      html: "<p>Good morning. Here's your daily newsletter digest.</p>" },
    { id: "m11", from: "Prize Center <winner@claim-reward-now.biz>", subject: "You have been selected!!!", ago: 4 * HOUR, labels: ["SPAM"],
      body: "Congratulations, claim your $1000 gift card now." },
    { id: "m12", from: "Instagram <no-reply@mail.instagram.com>", subject: "sarah.j and 4 others liked your post", ago: 7 * HOUR, labels: ["INBOX", "CATEGORY_SOCIAL"], headers: PROMO,
      body: "See what's new on Instagram." },
    { id: "m13", from: "Priya Shah <priya.shah@gmail.com>", subject: "Carpool next week?", ago: 11 * HOUR,
      body: "Hey! Can you do Tuesday and Thursday pickup next week? I've got a work trip Mon-Wed. Let me know either way so I can sort out a backup." },
    { id: "m14", from: "Bright Smiles Pediatric Dental <appointments@brightsmilesdental.com>", subject: "Appointment reminder: Mia, Oct 8 at 3:30pm", ago: 14 * HOUR, headers: PROMO,
      body: "This is a reminder of Mia's cleaning on Thursday, October 8 at 3:30 PM. Reply C to confirm or call to reschedule. A $50 fee applies to missed appointments." },
    { id: "m15", from: "Zoom <no-reply@zoom.us>", subject: "Webinar: Grow your aesthetics practice", ago: 15 * HOUR, labels: ["INBOX", "CATEGORY_PROMOTIONS"], headers: PROMO,
      html: "<p>Join our free webinar next week.</p>" },
    { id: "m16", from: "Unknown Vendor <sales@laser-supply-direct.com>", subject: "Quick question about your clinic", ago: 18 * HOUR,
      body: "Hi there, I noticed your med spa and wanted to see if you're the right person to talk to about laser maintenance contracts?" },
    { id: "m17", from: "Kaiser Permanente <noreply@kp.org>", subject: "New test results are available", ago: 22 * HOUR, labels: ["INBOX", "CATEGORY_UPDATES"],
      body: "You have new test results available. Sign in to kp.org to view them." },
    { id: "m18", from: "Amazon <shipment-tracking@amazon.com>", subject: "Your package was delivered", ago: 12 * HOUR, labels: ["INBOX", "CATEGORY_UPDATES"],
      body: "Your package was delivered to the front door." },
    { id: "m19", from: "Sephora <sephora@beauty.sephora.com>", subject: "Your Beauty Insider points expire soon", ago: 40 * HOUR, labels: ["INBOX", "CATEGORY_PROMOTIONS"], headers: PROMO,
      html: "<p>Use your points before they expire. Shop now.</p>" },
    { id: "m20", from: "Coach Rivera <coach.rivera@gmail.com>", subject: "Soccer: game moved to Saturday 9am", ago: 1 * HOUR,
      body: "Parents, heads up, Saturday's game moved to 9am at Field 3 because of the storm forecast. Please RSVP by Thursday if your kid can't make it so I can plan the lineup." },
  ];
  const sent = [
    { id: "s01", from: "Kaye Rivera <kaye@example.com>", to: "Ms. Alvarez <jalvarez@lincoln.k12.ca.us>", subject: "Mia's reading log", ago: 200 * HOUR, labels: ["SENT"], body: "Thanks for the update." },
    { id: "s02", from: "Kaye Rivera <kaye@example.com>", to: "Marcus Bell <marcus@bellconstruction.com>", subject: "Q4 med spa renovation timeline", threadId: "t03", ago: 30 * HOUR, labels: ["SENT"], body: "Hi Marcus, what's the earliest you can start? Budget was $17,200." },
    { id: "s03", from: "Kaye Rivera <kaye@example.com>", to: "Marcus Bell <marcus@bellconstruction.com>, \"Dana Whitfield, Esq.\" <dwhitfield@whitfieldlaw.com>", subject: "Contract", ago: 400 * HOUR, labels: ["SENT"], body: "Looping in Dana." },
    { id: "s04", from: "Kaye Rivera <kaye@example.com>", to: "Priya Shah <priya.shah@gmail.com>", subject: "Carpool", ago: 300 * HOUR, labels: ["SENT"], body: "Sure thing!" },
    { id: "s05", from: "Kaye Rivera <kaye@example.com>", to: "Priya Shah <priya.shah@gmail.com>", subject: "Re: Carpool", ago: 100 * HOUR, labels: ["SENT"], body: "See you then" },
  ];
  return [...inbox, ...sent].map((m) => gmailMessage(m, now));
}

// A Gmail client backed by the fake mailbox. Supports the subset of
// search syntax the app uses: in:inbox / in:sent, newer_than:Nd, after:<epoch>.
export function createFakeGmail(account, mailbox) {
  const trashed = new Set();
  const matches = (msg, q) => {
    if (q.includes("in:inbox") && (!msg.labelIds.includes("INBOX") && !msg.labelIds.includes("SPAM"))) return false;
    if (q.includes("in:sent") && !msg.labelIds.includes("SENT")) return false;
    const after = q.match(/after:(\d+)/);
    if (after && Number(msg.internalDate) < Number(after[1]) * 1000) return false;
    const newer = q.match(/newer_than:(\d+)d/);
    if (newer && Number(msg.internalDate) < Date.now() - Number(newer[1]) * 864e5) return false;
    return !trashed.has(msg.id);
  };
  return {
    account,
    calls: { trash: [], untrash: [] },
    async profile() {
      return { emailAddress: account.email };
    },
    async listMessageIds(q, max = 500) {
      return mailbox.filter((m) => matches(m, q)).sort((a, b) => b.internalDate - a.internalDate).slice(0, max).map((m) => m.id);
    },
    async getMetadata(ids) {
      const { normalizeMessage } = await import("../lib/mail-parse.js");
      return ids.map((id) => {
        const m = mailbox.find((x) => x.id === id);
        return normalizeMessage({ ...m, payload: { headers: m.payload.headers } }, account.id);
      });
    },
    async getFull(id) {
      const { normalizeMessage } = await import("../lib/mail-parse.js");
      return normalizeMessage(mailbox.find((x) => x.id === id), account.id);
    },
    async getThread(threadId) {
      const { normalizeMessage } = await import("../lib/mail-parse.js");
      return mailbox.filter((m) => m.threadId === threadId).sort((a, b) => a.internalDate - b.internalDate).map((m) => normalizeMessage(m, account.id));
    },
    async trash(id) {
      trashed.add(id);
      this.calls.trash.push(id);
    },
    async untrash(id) {
      trashed.delete(id);
      this.calls.untrash.push(id);
    },
  };
}
