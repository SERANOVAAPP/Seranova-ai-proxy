import { sign, verify } from "./crypto.js";

// ── Tiny router ───────────────────────────────────────────────────────
// All /api/* routes are served by ONE Vercel function (api/router.js).
// Vercel's Hobby plan caps a deployment at 12 functions, and this app has
// more routes than that, so we dispatch by path here instead.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const names = [];
    const regex = new RegExp(
      "^" + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")) + "/?$"
    );
    routes.push({ method, regex, names, handler, public: Boolean(opts.public) });
  };
  return {
    get: (p, h, o) => add("GET", p, h, o),
    post: (p, h, o) => add("POST", p, h, o),
    put: (p, h, o) => add("PUT", p, h, o),
    patch: (p, h, o) => add("PATCH", p, h, o),
    delete: (p, h, o) => add("DELETE", p, h, o),
    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      // Vercel rewrites /api/foo -> /api/router?route=foo
      const path = "/" + (url.searchParams.get("route") ?? url.pathname.replace(/^\/api\/?/, "")).replace(/^\/+/, "");
      res.setHeader("Cache-Control", "no-store");
      try {
        const match = routes.find((r) => r.method === req.method && r.regex.test(path));
        if (!match) {
          const pathExists = routes.some((r) => r.regex.test(path));
          throw new HttpError(pathExists ? 405 : 404, pathExists ? "Method not allowed" : "Not found");
        }
        const session = getSession(req);
        if (!match.public && !session) throw new HttpError(401, "Not signed in");
        if (!match.public && req.method !== "GET") assertSameOrigin(req);
        const params = Object.fromEntries(match.names.map((n, i) => [n, decodeURIComponent(path.match(match.regex)[i + 1])]));
        const result = await match.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body: await readBody(req), session });
        if (!res.writableEnded && !res.headersSent) sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status >= 500) console.error(`[api] ${req.method} ${path} failed:`, err);
        if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? "Something went wrong" : err.message, details: status >= 500 ? err.message : undefined });
      }
    },
  };
}

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    return req.body ?? {};
  }
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

// ── Session cookie ────────────────────────────────────────────────────
// Single-user personal tool: one password (APP_PASSWORD) unlocks the app.
// The cookie is HttpOnly + SameSite=Lax; mutating requests also require a
// same-origin Origin header as CSRF protection.

const SESSION_COOKIE = "ip_session";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(";").map((c) => c.trim()).filter(Boolean).map((c) => {
      const i = c.indexOf("=");
      return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
    })
  );
}

export function getSession(req) {
  return verify(parseCookies(req)[SESSION_COOKIE]);
}

export function setSessionCookie(req, res) {
  const token = sign({ user: "owner" }, SESSION_TTL);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${isSecure(req) ? "; Secure" : ""}`);
}

export function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? "; Secure" : ""}`);
}

function isSecure(req) {
  return (req.headers["x-forwarded-proto"] || "").includes("https") || process.env.VERCEL === "1";
}

export function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients (curl) carry no Origin; the cookie still gates them
  if (origin !== baseUrl(req)) throw new HttpError(403, "Cross-origin request blocked");
}
