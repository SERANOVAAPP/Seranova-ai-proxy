import { encrypt, decrypt } from "./crypto.js";
import { normalizeMessage } from "./mail-parse.js";
import { mapLimit } from "./util.js";

// ── Google OAuth + Gmail REST client ──────────────────────────────────
// Plain fetch against Google's REST endpoints (the official googleapis
// package is ~100MB and we only need a handful of calls).
//
// Scope: gmail.modify = read mail, move to trash, change labels, send.
// It does NOT allow permanent deletion, which matches the spec's
// "bulk delete goes to trash, never straight to permanent deletion".

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

function clientCreds() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  return { id, secret };
}

export function googleAuthUrl({ redirectUri, state, loginHint }) {
  const params = new URLSearchParams({
    client_id: clientCreds().id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline", // gives us a refresh token
    prompt: "consent", // always return a refresh token, even on reconnect
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCode({ code, redirectUri, fetchImpl = fetch }) {
  const { id, secret } = clientCreds();
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`);
  return data; // { access_token, refresh_token, expires_in, scope }
}

// Which Gmail address did the user just sign in with?
export async function fetchGmailAddress(accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${GMAIL}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Could not read Gmail profile (${res.status})`);
  return (await res.json()).emailAddress.toLowerCase();
}

export class GoogleAuthError extends Error {}

// In-memory access-token cache, per warm function instance.
const tokenCache = new Map();

async function accessTokenFor(account, fetchImpl) {
  const cached = tokenCache.get(account.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const { id, secret } = clientCreds();
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: decrypt(account.refreshToken), grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!res.ok) {
    // invalid_grant = user revoked access or the token expired (7 days for
    // apps left in Google's "Testing" mode). The account must reconnect.
    throw new GoogleAuthError(`Google refused the saved sign-in for ${account.email} (${data.error}). Reconnect this account in Settings.`);
  }
  tokenCache.set(account.id, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

export function sealRefreshToken(refreshToken) {
  return encrypt(refreshToken);
}

export function createGmailClient(account, { fetchImpl = fetch } = {}) {
  async function call(path, { method = "GET", body, query } = {}, attempt = 0) {
    const token = await accessTokenFor(account, fetchImpl);
    const url = `${GMAIL}${path}${query ? `?${query}` : ""}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return call(path, { method, body, query }, attempt + 1);
    }
    if (res.status === 401 && attempt === 0) {
      tokenCache.delete(account.id);
      return call(path, { method, body, query }, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    account,

    profile: () => call("/profile"),

    // All message ids matching a Gmail search query, newest first.
    async listMessageIds(q, max = 500) {
      const ids = [];
      let pageToken;
      do {
        const params = new URLSearchParams({ q, maxResults: String(Math.min(500, max - ids.length)) });
        if (pageToken) params.set("pageToken", pageToken);
        const data = await call("/messages", { query: params.toString() });
        for (const m of data.messages || []) ids.push(m.id);
        pageToken = data.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids;
    },

    async getMetadata(ids) {
      const params = new URLSearchParams({ format: "metadata" });
      for (const h of ["From", "To", "Cc", "Reply-To", "Subject", "Date", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"]) {
        params.append("metadataHeaders", h);
      }
      return mapLimit(ids, 8, async (id) => normalizeMessage(await call(`/messages/${id}`, { query: params.toString() }), account.id));
    },

    async getFull(id) {
      return normalizeMessage(await call(`/messages/${id}`, { query: "format=full" }), account.id);
    },

    async getThread(threadId) {
      const data = await call(`/threads/${threadId}`, { query: "format=full" });
      return (data.messages || []).map((m) => normalizeMessage(m, account.id));
    },

    trash: (id) => call(`/messages/${id}/trash`, { method: "POST" }),
    untrash: (id) => call(`/messages/${id}/untrash`, { method: "POST" }),
  };
}
