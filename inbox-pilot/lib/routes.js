import { createRouter, HttpError, redirect, setSessionCookie, clearSessionCookie, getSession, baseUrl } from "./http.js";
import { safeEqual, randomId } from "./crypto.js";
import { getStore, keys } from "./store.js";
import { googleAuthUrl, exchangeCode, sealRefreshToken, fetchGmailAddress } from "./google.js";
import { providers } from "./providers.js";
import { listAccounts, getAccount, saveAccount, removeAccount, publicAccount, ACCOUNT_COLORS } from "./accounts.js";
import { loadProfile, saveProfile, applyProfileEdits, analyzeSentMail, mergeCorrespondents } from "./profile.js";
import { runTriage, getRunStatus } from "./triage.js";
import { getBrief, getItem, applyAction, teachSender, getOriginal, getCleanup } from "./brief.js";
import { inngest, inngestConfigured, TRIAGE_EVENT } from "./inngest.js";

const router = createRouter();

// ── Session ───────────────────────────────────────────────────────────

router.get("/session", async ({ req }) => {
  const signedIn = Boolean(getSession(req));
  return { signedIn, configured: Boolean(process.env.APP_PASSWORD && process.env.APP_SECRET) };
}, { public: true });

const loginAttempts = new Map(); // ip -> { count, resetAt } (per warm instance; slows guessing)

router.post("/login", async ({ req, res, body }) => {
  if (!process.env.APP_PASSWORD) throw new HttpError(500, "APP_PASSWORD is not set");
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0];
  const a = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60_000 };
  if (Date.now() > a.resetAt) Object.assign(a, { count: 0, resetAt: Date.now() + 15 * 60_000 });
  if (a.count >= 10) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  if (!safeEqual(body.password || "", process.env.APP_PASSWORD)) {
    a.count += 1;
    loginAttempts.set(ip, a);
    throw new HttpError(401, "Wrong password");
  }
  loginAttempts.delete(ip);
  setSessionCookie(req, res);
  return { ok: true };
}, { public: true });

router.post("/logout", async ({ req, res }) => {
  clearSessionCookie(req, res);
  return { ok: true };
}, { public: true });

// ── Google account connection (OAuth) ─────────────────────────────────

router.get("/auth/google/start", async ({ req, res, query }) => {
  const state = randomId("st_");
  const store = await getStore();
  await store.set(keys.oauthState(state), { label: String(query.label || "").slice(0, 40), createdAt: Date.now() });
  redirect(res, googleAuthUrl({ redirectUri: `${baseUrl(req)}/api/auth/google/callback`, state, loginHint: query.hint }));
});

router.get("/auth/google/callback", async ({ req, res, query }) => {
  const fail = (msg) => redirect(res, `/#/settings?error=${encodeURIComponent(msg)}`);
  if (query.error) return fail(query.error === "access_denied" ? "Google sign-in was cancelled" : `Google error: ${query.error}`);
  const store = await getStore();
  const pending = await store.get(keys.oauthState(query.state || ""));
  await store.del(keys.oauthState(query.state || ""));
  if (!pending || Date.now() - pending.createdAt > 15 * 60_000) return fail("Sign-in link expired, please try again");

  const tokens = await exchangeCode({ code: query.code, redirectUri: `${baseUrl(req)}/api/auth/google/callback` });
  if (!tokens.scope?.includes("gmail.modify")) return fail("Gmail access was not granted. Please tick the Gmail permission box.");
  if (!tokens.refresh_token) return fail("Google did not return a long-lived token. Remove the app at myaccount.google.com/permissions and try again.");

  const accounts = await listAccounts();
  const emailAddress = await fetchGmailAddress(tokens.access_token);
  const existing = accounts.find((a) => a.email === emailAddress);
  const account = {
    ...(existing || {}),
    id: existing?.id || randomId("acc_"),
    provider: "gmail",
    email: emailAddress,
    label: pending.label || existing?.label || emailAddress.split("@")[0],
    color: existing?.color || ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length],
    refreshToken: sealRefreshToken(tokens.refresh_token),
    status: "ok",
    statusMessage: "",
    createdAt: existing?.createdAt || Date.now(),
  };
  await saveAccount(account);
  redirect(res, `/#/onboarding?connected=${encodeURIComponent(account.email)}`);
});

router.get("/accounts", async () => ({ accounts: (await listAccounts()).map(publicAccount) }));

router.patch("/accounts/:id", async ({ params, body }) => {
  const account = await getAccount(params.id);
  if (!account) throw new HttpError(404, "Account not found");
  if (typeof body.label === "string") account.label = body.label.trim().slice(0, 40) || account.label;
  if (typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)) account.color = body.color;
  return publicAccount(await saveAccount(account));
});

// Disconnect: forgets the token here. Revoke at myaccount.google.com/permissions too.
router.delete("/accounts/:id", async ({ params }) => {
  await removeAccount(params.id);
  return { ok: true };
});

// ── Importance profile ────────────────────────────────────────────────

function publicProfile(p) {
  return {
    ...p,
    correspondents: undefined,
    correspondentDomains: undefined,
    correspondentCount: Object.keys(p.correspondents).length,
    topCorrespondents: Object.entries(p.correspondents).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([email, count]) => ({ email, count })),
  };
}

router.get("/profile", async () => publicProfile(await loadProfile()));

router.put("/profile", async ({ body }) => publicProfile(await saveProfile(applyProfileEdits(await loadProfile(), body))));

router.delete("/profile/overrides", async ({ body }) => {
  const profile = await loadProfile();
  const overrides = { ...profile.overrides };
  delete overrides[String(body.key || "")];
  return publicProfile(await saveProfile({ ...profile, overrides }));
});

// Scan sent mail of every connected account (metadata only).
router.post("/profile/analyze-sent", async () => {
  let profile = await loadProfile();
  const results = [];
  for (const account of await listAccounts()) {
    const found = await analyzeSentMail(providers.gmailFor(account));
    profile = mergeCorrespondents(profile, found);
    results.push({ account: account.email, scanned: found.scanned, people: Object.keys(found.people).length });
  }
  await saveProfile(profile);
  return { results, correspondentCount: Object.keys(profile.correspondents).length };
});

// ── Triage ────────────────────────────────────────────────────────────

router.post("/triage/run", async () => {
  const current = await getRunStatus();
  if (current.state === "running" && Date.now() - current.startedAt < 15 * 60_000) return { queued: false, status: current };
  if (inngestConfigured()) {
    await inngest.send({ name: TRIAGE_EVENT, data: { reason: "manual" } });
    return { queued: true };
  }
  return { queued: false, status: await runTriage({ reason: "manual" }) };
});

router.get("/triage/status", async () => getRunStatus());

// ── Brief + actions ───────────────────────────────────────────────────

router.get("/brief", async () => getBrief());
router.get("/items/:id", async ({ params }) => getItem(params.id));
router.get("/items/:id/original", async ({ params }) => getOriginal(params.id));
router.post("/items/:id/action", async ({ params, body }) => applyAction(params.id, body.action));
router.post("/items/:id/teach", async ({ params, body }) => teachSender(params.id, { bucket: body.bucket ?? null, scope: body.scope === "domain" ? "domain" : "sender" }));
router.get("/cleanup", async () => getCleanup());

export default router;
