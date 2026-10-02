import crypto from "node:crypto";

// ── Secrets ───────────────────────────────────────────────────────────
// APP_SECRET is a long random string set in Vercel env vars. It signs the
// login cookie and (via a derived key) encrypts Google refresh tokens at
// rest, so a leaked Redis dump alone cannot be used to read your mail.

function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("APP_SECRET must be set to a random string of at least 32 characters");
  }
  return secret;
}

function deriveKey(purpose) {
  return crypto.createHash("sha256").update(`${purpose}:${appSecret()}`).digest();
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey("token-encryption"), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

export function decrypt(token) {
  const [version, iv, tag, body] = String(token).split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unrecognized encrypted value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey("token-encryption"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

// Signed, expiring tokens: "<payload>.<hmac>"
export function sign(payload, ttlSeconds) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const mac = crypto.createHmac("sha256", deriveKey("session")).update(data).digest("base64url");
  return `${data}.${mac}`;
}

export function verify(token) {
  if (typeof token !== "string") return null;
  const [data, mac] = token.split(".");
  if (!data || !mac) return null;
  const expected = crypto.createHmac("sha256", deriveKey("session")).update(data).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomId(prefix = "") {
  return prefix + crypto.randomBytes(9).toString("base64url");
}
