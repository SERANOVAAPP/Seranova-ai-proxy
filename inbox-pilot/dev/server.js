// Local development server: serves public/ and routes /api/* to the same
// router Vercel uses. Run `npm run dev` (real Gmail + Claude, needs .env
// values) or `npm run demo` (fake mailbox + offline AI, no setup at all).
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 3000);

// Minimal .env loader (no dependency).
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const DEMO = process.env.DEMO_MODE === "1";
if (DEMO) {
  process.env.APP_PASSWORD ||= "demo";
  process.env.APP_SECRET ||= "demo-secret-demo-secret-demo-secret-0000";
  delete process.env.KV_REST_API_URL; // always in-memory
  delete process.env.INNGEST_EVENT_KEY; // run triage inline
}

const { default: router } = await import("../lib/routes.js");

if (DEMO) {
  const { setProviders } = await import("../lib/providers.js");
  const { saveAccount } = await import("../lib/accounts.js");
  const { buildMailbox, createFakeGmail } = await import("./fake-mailbox.js");
  const mailbox = buildMailbox();
  const account = { id: "acc_demo", provider: "gmail", email: "kaye@example.com", label: "Personal", color: "#2f6f62", refreshToken: "demo", status: "ok", createdAt: Date.now() };
  await saveAccount(account);
  const gmail = createFakeGmail(account, mailbox);
  const ai = process.env.ANTHROPIC_API_KEY ? await import("../lib/ai.js") : await import("./fake-ai.js");
  setProviders({ gmailFor: () => gmail, ai });
  console.log(`Demo mode: fake mailbox, ${process.env.ANTHROPIC_API_KEY ? "real Claude" : "offline fake AI"}. Password: ${process.env.APP_PASSWORD}`);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return router.handle(req, res);
  let file = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(path.join(root, "public"))) return res.writeHead(403).end();
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    file = path.join(root, "public", "index.html");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
}).listen(PORT, () => console.log(`Inbox Pilot running at http://localhost:${PORT}`));
