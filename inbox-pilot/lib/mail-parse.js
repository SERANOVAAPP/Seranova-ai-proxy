// ── Email parsing helpers (Gmail API message format) ──────────────────

export function headerMap(payload) {
  const map = {};
  for (const h of payload?.headers || []) map[h.name.toLowerCase()] = h.value;
  return map;
}

// "Jane Doe <jane@x.com>" -> { name: "Jane Doe", email: "jane@x.com" }
export function parseAddress(raw) {
  if (!raw) return { name: "", email: "" };
  const s = raw.trim();
  const angle = s.match(/^(.*)<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1].trim().replace(/^"|"$/g, "").replace(/\\"/g, '"').trim();
    const email = angle[2].trim().toLowerCase();
    return { name: name || email, email };
  }
  const email = s.replace(/^"|"$/g, "").toLowerCase();
  return { name: email, email };
}

// Split an address list on commas that are not inside quotes or <...>.
export function parseAddressList(raw) {
  if (!raw) return [];
  const parts = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(parseAddress).filter((a) => a.email.includes("@"));
}

export function domainOf(email) {
  return (email.split("@")[1] || "").toLowerCase();
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// Walk the MIME tree; prefer text/plain, fall back to stripped HTML.
export function extractBody(payload) {
  let plain = "";
  let html = "";
  const walk = (part) => {
    if (!part) return;
    const data = part.body?.data;
    if (data && !part.filename) {
      if (part.mimeType === "text/plain" && !plain) plain = decodeBase64Url(data);
      else if (part.mimeType === "text/html" && !html) html = decodeBase64Url(data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  const text = plain.trim() ? plain : htmlToText(html);
  return text.replace(/\r\n/g, "\n").trim();
}

// Drop quoted history ("On Tue, X wrote:" and "> " lines) so thread
// summaries don't re-read the same text for every message.
export function stripQuoted(text) {
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (line.trim().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function attachmentNames(payload) {
  const names = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename) names.push(part.filename);
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return names;
}

// Normalize a Gmail message (metadata or full format) into the shape the
// triage pipeline works with. Body text is only present for format=full.
export function normalizeMessage(msg, accountId) {
  const h = headerMap(msg.payload);
  const from = parseAddress(h["from"]);
  return {
    id: msg.id,
    threadId: msg.threadId,
    accountId,
    from,
    to: parseAddressList(h["to"]),
    cc: parseAddressList(h["cc"]),
    replyTo: h["reply-to"] ? parseAddress(h["reply-to"]) : null,
    subject: (h["subject"] || "(no subject)").trim(),
    date: Number(msg.internalDate) || Date.parse(h["date"]) || Date.now(),
    snippet: decodeEntities(msg.snippet || ""),
    labelIds: msg.labelIds || [],
    listUnsubscribe: h["list-unsubscribe"] || "",
    listId: h["list-id"] || "",
    precedence: (h["precedence"] || "").toLowerCase(),
    autoSubmitted: (h["auto-submitted"] || "").toLowerCase(),
    body: msg.payload?.parts || msg.payload?.body?.data ? extractBody(msg.payload) : "",
    attachments: attachmentNames(msg.payload),
  };
}

function decodeEntities(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
