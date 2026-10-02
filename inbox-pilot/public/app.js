// Inbox Pilot front end. No build step: plain ES modules.
// All email-derived text is inserted with textContent (never innerHTML),
// because email content is written by strangers.

const $app = document.getElementById("app");

// ── helpers ───────────────────────────────────────────────────────────

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.setAttribute("style", v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// replaceChildren/append that skip null/undefined/false like h() does.
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const ICONS = {
  reply: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v5",
  x: "M18 6 6 18M6 6l12 12",
  trash: "M3 6h18M8 6V4h8v2m1 0v14H7V6",
  back: "M15 18l-6-6 6-6",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  broom: "M14 4 9 13m-4 1h9l1 6H4l1-6Zm2 3v3m4-3v3",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICONS[name]);
  svg.append(p);
  return svg;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "login") {
    location.hash = "#/login";
    throw new Error("Please sign in");
  }
  if (!res.ok) throw new Error(data.details ? `${data.error}: ${data.details}` : data.error || `Request failed (${res.status})`);
  return data;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs}h`;
  const d = Math.round(hrs / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dueLabel(d) {
  if (!d.due_date) return d.due_text || "Soon";
  const due = new Date(d.due_date + "T12:00:00");
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return `Overdue · ${due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days < 7) return `Due ${due.toLocaleDateString(undefined, { weekday: "long" })}`;
  return `Due ${due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

let toastTimer;
function toast(message, action) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = h("div", { class: "toast", role: "status" }, h("span", {}, message),
    action && h("button", { onclick: async () => { el.remove(); await action.run(); } }, action.label));
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 6000);
}

function topbar(title, { back, actions = [] } = {}) {
  return h("header", { class: "topbar" },
    back && h("button", { class: "iconbtn", "aria-label": "Back", onclick: () => (history.length > 1 ? history.back() : (location.hash = back)) }, icon("back")),
    h("h1", {}, title),
    ...actions);
}

function accountDot(accounts, id) {
  const a = accounts.find((x) => x.id === id);
  return h("span", { class: "dot", style: `background:${a?.color || "#999"}`, title: a ? `${a.label} (${a.email})` : "" });
}

const state = { brief: null };

// ── router ────────────────────────────────────────────────────────────

const routes = {
  login: renderLogin,
  brief: renderBrief,
  item: renderItem,
  cleanup: renderCleanup,
  settings: renderSettings,
  onboarding: renderOnboarding,
};

async function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const [name, ...args] = path.split("/");
  const params = Object.fromEntries(new URLSearchParams(qs || ""));
  const view = routes[name] || renderBrief;
  window.scrollTo(0, 0);
  try {
    await view(args.map(decodeURIComponent), params);
  } catch (err) {
    if (err.message === "Please sign in") return;
    fill($app, topbar("Inbox Pilot"), h("div", { class: "notice warn" }, err.message));
  }
}
window.addEventListener("hashchange", route);

// ── login ─────────────────────────────────────────────────────────────

async function renderLogin() {
  const session = await api("session");
  if (session.signedIn) return (location.hash = "#/brief");
  const err = h("div", { class: "error", role: "alert" });
  const input = h("input", { type: "password", id: "pw", autocomplete: "current-password", required: true });
  const form = h("form", { class: "card login", onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      try {
        await api("login", { method: "POST", body: { password: input.value } });
        location.hash = "#/brief";
      } catch (ex) {
        err.textContent = ex.message;
      }
    } },
    h("h1", {}, "Inbox Pilot"),
    h("p", { class: "muted" }, "What matters in your inbox, without reading all of it."),
    !session.configured && h("div", { class: "notice warn" }, "APP_PASSWORD and APP_SECRET are not set on the server yet. See the README."),
    h("div", { class: "field" }, h("label", { for: "pw" }, "Password"), input),
    h("button", { class: "btn primary block", style: "margin-top:16px" }, "Sign in"),
    err);
  fill($app, h("div", { class: "center" }, form));
  input.focus();
}

// ── brief ─────────────────────────────────────────────────────────────

async function renderBrief() {
  const brief = await api("brief");
  state.brief = brief;
  if (!brief.accounts.length || !brief.profile.onboarded) return (location.hash = "#/onboarding");

  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = brief.profile.ownerName ? `, ${brief.profile.ownerName.split(" ")[0]}` : "";
  const clean = brief.counts.junk + brief.counts.subscriptions;

  const refreshBtn = h("button", { class: "iconbtn", "aria-label": "Check for new mail", onclick: () => startRun(refreshBtn) }, icon("refresh"));
  const runLine = h("p", { class: "small muted", id: "runline" }, runSummary(brief.run));

  fill($app, 
    topbar("Inbox Pilot", { actions: [refreshBtn, h("a", { class: "iconbtn", href: "#/settings", "aria-label": "Settings" }, icon("gear"))] }),
    h("section", { class: "hero" },
      h("h2", {}, `${greet}${name}.`),
      h("p", {}, new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })),
      h("div", { class: "stats" },
        h("span", { class: "stat" }, h("b", {}, brief.important.length), " important"),
        h("span", { class: "stat" }, h("b", {}, brief.possibly.length), " unsure"),
        h("span", { class: "stat" }, h("b", {}, clean), " to clean up")),
      runLine),
    brief.deadlines.length ? h("div", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "Deadlines"), h("span", {}, brief.deadlines.length)),
      h("div", { class: "deadlines" }, brief.deadlines.slice(0, 12).map((d) =>
        h("a", { class: "deadline", href: `#/item/${encodeURIComponent(d.itemId)}` },
          h("div", { class: "due" }, dueLabel(d)),
          h("div", { class: "what" }, d.what),
          h("div", { class: "src" }, d.from))))) : null,
    emailSection("Important", brief.important, brief.accounts, { empty: "Nothing important waiting. Nice." }),
    emailSection("Possibly important", brief.possibly, brief.accounts, { unsure: true, empty: "Nothing uncertain right now." }),
    brief.respondQueue.length ? emailSection("To respond", brief.respondQueue, brief.accounts, { queue: true }) : null,
    h("div", { class: "section" },
      h("a", { class: "card teaser", href: "#/cleanup" },
        h("span", { class: "num" }, clean),
        h("span", { class: "txt" }, `junk and subscription emails sorted out of your brief`),
        icon("broom"))),
  );
  if (brief.run.state === "running") pollRun(refreshBtn);
}

function runSummary(run) {
  if (!run || run.state === "never") return "No mail checked yet.";
  if (run.state === "running") return `Working… ${run.phase || ""}`;
  if (run.state === "failed") return `Last check failed: ${run.error}`;
  return `Checked ${timeAgo(run.finishedAt)} ago · ${run.counts.scanned} new email${run.counts.scanned === 1 ? "" : "s"}`;
}

function emailSection(title, items, accounts, opts = {}) {
  const list = h("div", { class: "card list" });
  if (!items.length) list.append(h("div", { class: "empty" }, opts.empty || "Nothing here."));
  for (const it of items) list.append(emailRow(it, accounts, opts));
  return h("div", { class: "section" },
    h("div", { class: "section-head" }, h("h3", {}, title), h("span", {}, items.length || "")),
    opts.queue && h("p", { class: "small muted", style: "margin:0 2px 8px" }, "AI reply drafts arrive in Phase 3. For now, reply from Gmail and tap Done."),
    list);
}

function emailRow(it, accounts, opts) {
  const row = h("article", { class: "email" });
  const leave = async (action, label) => {
    row.classList.add("leaving");
    try {
      await api(`items/${encodeURIComponent(it.id)}/action`, { method: "POST", body: { action } });
      setTimeout(() => row.remove(), 250);
      toast(label, { label: "Undo", run: async () => { await api(`items/${encodeURIComponent(it.id)}/action`, { method: "POST", body: { action: "undo" } }); route(); } });
    } catch (err) {
      row.classList.remove("leaving");
      toast(err.message);
    }
  };
  const badges = [];
  if (it.urgency === "today") badges.push(h("span", { class: "badge urgent" }, "Today"));
  else if (it.urgency === "this_week") badges.push(h("span", { class: "badge soon" }, "This week"));
  if (it.needsReply) badges.push(h("span", { class: "badge reply" }, "Needs reply"));
  if (it.threadCount > 1) badges.push(h("span", { class: "badge" }, `${it.threadCount} in thread`));

  fill(row,
    h("a", { class: "email-main", href: `#/item/${encodeURIComponent(it.id)}` },
      h("div", { class: "email-meta" }, accountDot(accounts, it.accountId), h("span", { class: "who" }, it.from.name || it.from.email), h("span", { class: "when" }, timeAgo(it.date))),
      h("p", { class: "email-line" }, it.oneLine || it.subject),
      badges.length ? h("div", { class: "badges" }, badges) : null),
    opts.queue
      ? h("div", { class: "choices", style: "grid-template-columns:1fr 1fr" },
          h("button", { class: "choice", onclick: () => leave("ignore", "Marked done") }, "Done"),
          h("button", { class: "choice", onclick: () => leave("undo", "Back in the brief") }, "Back to brief"))
      : h("div", { class: "choices", role: "group", "aria-label": "Decide" },
          h("button", { class: "choice respond", onclick: () => leave("respond", "Added to your reply list") }, icon("reply"), "Respond"),
          h("button", { class: "choice", onclick: () => leave("ignore", "Ignored") }, icon("x"), "Ignore"),
          h("button", { class: "choice trash", onclick: () => leave("trash", "Moved to Gmail trash") }, icon("trash"), "Trash")),
    opts.unsure && h("div", { class: "teach" },
      h("button", { class: "btn small", onclick: () => teachAndRefresh(it, "important", row) }, "Always important"),
      h("button", { class: "btn small", onclick: () => teachAndRefresh(it, "junk", row) }, "Always junk")),
  );
  return row;
}

async function teachAndRefresh(it, bucket, row) {
  try {
    const r = await api(`items/${encodeURIComponent(it.id)}/teach`, { method: "POST", body: { bucket, scope: "sender" } });
    row?.classList.add("leaving");
    toast(`${it.from.name || it.from.email} will always be ${bucket}${r.refiled > 1 ? ` (${r.refiled} emails re-filed)` : ""}`, {
      label: "Undo",
      run: async () => { await api(`items/${encodeURIComponent(it.id)}/teach`, { method: "POST", body: { bucket: null } }); toast("Rule removed. Re-check mail to re-sort."); },
    });
    setTimeout(route, 300);
  } catch (err) {
    toast(err.message);
  }
}

async function startRun(btn) {
  btn.disabled = true;
  btn.replaceChildren(h("span", { class: "spin" }));
  const line = document.getElementById("runline");
  if (line) line.textContent = "Checking for new mail…";
  try {
    const r = await api("triage/run", { method: "POST" });
    if (r.queued || r.status?.state === "running") return pollRun(btn);
    await route();
    if (r.status?.counts) toast(`${r.status.counts.scanned} new · ${r.status.counts.important} important`);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
    btn.replaceChildren(icon("refresh"));
  }
}

async function pollRun(btn) {
  btn.disabled = true;
  btn.replaceChildren(h("span", { class: "spin" }));
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const run = await api("triage/status");
    const line = document.getElementById("runline");
    if (!line) return; // navigated away
    line.textContent = runSummary(run);
    if (run.state !== "running") return route();
  }
}

// ── item detail ───────────────────────────────────────────────────────

async function renderItem([id]) {
  const it = await api(`items/${encodeURIComponent(id)}`);
  const accounts = state.brief?.accounts || (await api("accounts")).accounts;
  const account = accounts.find((a) => a.id === it.accountId);
  let scope = "sender";
  const scopeSeg = h("div", { class: "seg", role: "group", "aria-label": "Apply to" },
    h("button", { class: "on", onclick: (e) => setScope("sender", e) }, "This sender"),
    h("button", { onclick: (e) => setScope("domain", e) }, `All of @${it.from.email.split("@")[1]}`));
  function setScope(s, e) {
    scope = s;
    [...scopeSeg.children].forEach((b) => b.classList.toggle("on", b === e.currentTarget));
  }
  const teachBtn = (bucket, label) => h("button", { class: "btn small", onclick: async () => {
      try {
        const r = await api(`items/${encodeURIComponent(it.id)}/teach`, { method: "POST", body: { bucket, scope } });
        toast(`Got it. ${r.refiled} email${r.refiled === 1 ? "" : "s"} re-filed.`);
      } catch (err) { toast(err.message); }
    } }, label);

  const originalBox = h("div", { class: "card pad hidden" });
  const showOriginal = h("button", { class: "btn small", onclick: async () => {
      showOriginal.disabled = true;
      showOriginal.replaceChildren(h("span", { class: "spin" }), "Loading from Gmail");
      try {
        const o = await api(`items/${encodeURIComponent(it.id)}/original`);
        fill(originalBox, 
          h("div", { class: "small muted" }, `From ${o.from.name} <${o.from.email}>`),
          h("div", { class: "small muted" }, `To ${o.to.map((t) => t.email).join(", ")}${o.cc.length ? ` · Cc ${o.cc.map((t) => t.email).join(", ")}` : ""}`),
          h("div", { class: "small muted", style: "margin-bottom:12px" }, new Date(o.date).toLocaleString()),
          h("pre", { class: "original" }, o.body),
          o.attachments.length ? h("p", { class: "small muted" }, `Attachments: ${o.attachments.join(", ")}`) : null,
          h("a", { class: "btn small", href: o.gmailUrl, target: "_blank", rel: "noopener" }, "Open in Gmail"));
        originalBox.classList.remove("hidden");
        showOriginal.remove();
      } catch (err) {
        toast(err.message);
        showOriginal.disabled = false;
        showOriginal.textContent = "Show original email";
      }
    } }, "Show original email");

  const act = (action, label) => async () => {
    try {
      await api(`items/${encodeURIComponent(it.id)}/action`, { method: "POST", body: { action } });
      toast(label, { label: "Undo", run: async () => { await api(`items/${encodeURIComponent(it.id)}/action`, { method: "POST", body: { action: "undo" } }); } });
      history.length > 1 ? history.back() : (location.hash = "#/brief");
    } catch (err) { toast(err.message); }
  };

  fill($app, 
    topbar("Email", { back: "#/brief" }),
    h("div", { class: "detail-head" },
      h("div", { class: "row-gap" },
        h("span", { class: "chip" }, accountDot(accounts, it.accountId), account ? account.label : "Account"),
        h("span", { class: "chip" }, { important: "Important", possibly: "Possibly important", subscriptions: "Subscription", junk: "Junk" }[it.bucket]),
        it.status !== "new" && h("span", { class: "chip" }, `Status: ${it.status}`)),
      h("h2", {}, it.subject),
      h("p", { class: "muted", style: "margin:0" }, `${it.from.name} · ${it.from.email} · ${new Date(it.date).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`)),
    h("div", { class: "card pad", style: "margin-top:16px" },
      h("p", { class: "summary" }, it.summary || "No summary for this email (it was sorted as junk or a subscription, so the AI skipped it to save cost)."),
      it.threadSoFar && h("div", {}, h("div", { class: "label" }, "Thread so far"), h("p", { style: "margin:0" }, it.threadSoFar)),
      it.replyReason && h("div", {}, h("div", { class: "label" }, it.needsReply ? "Needs a reply" : "Reply"), h("p", { style: "margin:0" }, it.replyReason)),
      it.deadlines?.length ? h("div", {}, h("div", { class: "label" }, "Deadlines"),
        h("ul", { class: "reasons" }, it.deadlines.map((d) => h("li", {}, `${d.what} · ${dueLabel(d)}`)))) : null,
      h("div", { class: "choices" },
        h("button", { class: "choice respond", onclick: act("respond", "Added to your reply list") }, icon("reply"), "Respond"),
        h("button", { class: "choice", onclick: act("ignore", "Ignored") }, icon("x"), "Ignore"),
        h("button", { class: "choice trash", onclick: act("trash", "Moved to Gmail trash") }, icon("trash"), "Trash"))),
    h("div", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "Why it's here")),
      h("div", { class: "card pad" }, h("ul", { class: "reasons" }, (it.reasons.length ? it.reasons : ["No strong signals either way"]).map((r) => h("li", {}, r))))),
    h("div", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "Teach Inbox Pilot")),
      h("div", { class: "card pad" },
        scopeSeg,
        h("div", { class: "row-gap", style: "margin-top:12px" },
          teachBtn("important", "Always important"),
          teachBtn("subscriptions", "Always a subscription"),
          teachBtn("junk", "Always junk")))),
    h("div", { class: "section" }, showOriginal, originalBox),
  );
}

// ── cleanup ───────────────────────────────────────────────────────────

async function renderCleanup() {
  const data = await api("cleanup");
  const list = h("div", { class: "card list" });
  if (!data.groups.length) list.append(h("div", { class: "empty" }, "Nothing to clean up."));
  for (const g of data.groups) {
    list.append(h("div", { class: "group" },
      h("span", { class: "count" }, g.count),
      h("div", { class: "info" }, h("b", {}, g.name || g.sender), h("span", {}, `${g.bucket === "junk" ? "Junk" : "Subscription"} · ${g.latestSubject}`)),
      h("button", { class: "btn small", onclick: async (e) => {
          await api(`items/${encodeURIComponent(g.latestItemId)}/teach`, { method: "POST", body: { bucket: "important", scope: "sender" } });
          e.currentTarget.closest(".group").remove();
          toast(`${g.name || g.sender} moved to Important`);
        } }, "Not junk")));
  }
  fill($app, 
    topbar("Cleanup", { back: "#/brief" }),
    h("section", { class: "hero" },
      h("h2", {}, `${data.total} emails`),
      h("p", {}, `from ${data.groups.length} senders, kept out of your brief.`)),
    h("div", { class: "notice" }, "One-tap delete across accounts and unsubscribe arrive in Phase 2. For now, check that nothing important ended up here, and tap Not junk if it did."),
    h("div", { class: "section" }, list));
}

// ── settings ──────────────────────────────────────────────────────────

const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "UTC"];

function profileFields(p) {
  const area = (key, label, hint, placeholder) => h("div", { class: "field" },
    h("label", { for: key }, label), hint && h("p", { class: "hint" }, hint),
    h("textarea", { id: key, name: key, placeholder }, (p[key] || []).join("\n")));
  return [
    h("div", { class: "field" }, h("label", { for: "ownerName" }, "Your name"), h("input", { type: "text", id: "ownerName", name: "ownerName", value: p.ownerName || "" })),
    area("neverMiss", "Never miss", "People, organizations, email addresses, or @domains. One per line. These always land in Important and (later) trigger a notification.", "Lincoln Elementary\n@whitfieldlaw.com\nMy bank"),
    area("schoolKeywords", "School and kids", "School names, teachers, your kids' names, activities.", "Lincoln\nMs. Alvarez\nMia\nsoccer"),
    area("workDomains", "Work domains", "Your business email domains, plus important clients or vendors.", "seranovamedspa.com"),
    area("urgentTopics", "Urgent topics", "Words that make any email urgent.", "lease\npayroll\ninspection"),
    area("alwaysNoise", "Always noise", "Senders that are never worth seeing.", "oldnavy.com\nLinkedIn"),
  ];
}

function readProfileForm(form) {
  const v = (n) => form.querySelector(`[name=${n}]`);
  const out = {};
  for (const n of ["ownerName", "neverMiss", "schoolKeywords", "workDomains", "urgentTopics", "alwaysNoise"]) if (v(n)) out[n] = v(n).value;
  if (v("briefTime")) out.briefTime = v("briefTime").value;
  if (v("timezone")) out.timezone = v("timezone").value;
  if (v("weekendBrief")) out.weekendBrief = v("weekendBrief").checked;
  for (const k of ["neverMiss", "schoolKeywords", "workDomains", "urgentTopics", "alwaysNoise"]) if (out[k] !== undefined) out[k] = out[k].split("\n");
  return out;
}

function briefTimeFields(p) {
  const tz = TIMEZONES.includes(p.timezone) ? TIMEZONES : [p.timezone, ...TIMEZONES];
  return [
    h("div", { class: "field" }, h("label", { for: "briefTime" }, "Daily brief time"), h("input", { type: "time", id: "briefTime", name: "briefTime", value: p.briefTime })),
    h("div", { class: "field" }, h("label", { for: "timezone" }, "Time zone"),
      h("select", { id: "timezone", name: "timezone" }, tz.map((z) => h("option", { value: z, selected: z === p.timezone }, z.replace("_", " "))))),
    h("div", { class: "field check" }, h("input", { type: "checkbox", id: "weekendBrief", name: "weekendBrief", checked: p.weekendBrief }), h("label", { for: "weekendBrief", style: "margin:0;font-weight:500" }, "Send a brief on weekends too")),
  ];
}

function accountsCard(accounts, { reload }) {
  const card = h("div", { class: "card list" });
  if (!accounts.length) card.append(h("div", { class: "empty" }, "No accounts connected yet."));
  for (const a of accounts) {
    card.append(h("div", { class: "acct" },
      h("input", { type: "color", class: "swatch", value: a.color, "aria-label": `Color for ${a.email}`, onchange: async (e) => { await api(`accounts/${a.id}`, { method: "PATCH", body: { color: e.target.value } }); } }),
      h("div", { class: "info" },
        h("b", {}, a.label),
        h("span", {}, a.email),
        a.status === "error" && h("div", { class: "error" }, a.statusMessage)),
      a.status === "error" && h("a", { class: "btn small", href: `/api/auth/google/start?hint=${encodeURIComponent(a.email)}` }, "Reconnect"),
      h("button", { class: "btn small", onclick: async () => {
          const label = prompt("Label for this account", a.label);
          if (label) { await api(`accounts/${a.id}`, { method: "PATCH", body: { label } }); reload(); }
        } }, "Rename"),
      h("button", { class: "btn small danger", onclick: async () => {
          if (!confirm(`Disconnect ${a.email}? Also remove access at myaccount.google.com/permissions.`)) return;
          await api(`accounts/${a.id}`, { method: "DELETE" });
          reload();
        } }, "Remove")));
  }
  return card;
}

async function renderSettings(_args, params) {
  const [profile, { accounts }] = await Promise.all([api("profile"), api("accounts")]);
  const status = h("div", { class: "small muted", role: "status" });
  const form = h("form", { onsubmit: async (e) => {
      e.preventDefault();
      status.textContent = "Saving…";
      try {
        await api("profile", { method: "PUT", body: readProfileForm(form) });
        status.textContent = "Saved.";
        toast("Settings saved");
      } catch (err) { status.textContent = err.message; }
    } },
    h("div", { class: "card pad" }, ...profileFields(profile)),
    h("div", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, "Daily brief")), h("div", { class: "card pad" }, ...briefTimeFields(profile))),
    h("div", { class: "row-gap", style: "margin-top:16px" }, h("button", { class: "btn primary" }, "Save settings"), status));

  const overrides = Object.entries(profile.overrides || {});
  const rescan = h("button", { class: "btn small", onclick: async () => {
      rescan.disabled = true;
      rescan.replaceChildren(h("span", { class: "spin" }), "Scanning");
      try {
        const r = await api("profile/analyze-sent", { method: "POST" });
        toast(`Found ${r.correspondentCount} people you write to`);
        renderSettings([], {});
      } catch (err) { toast(err.message); rescan.disabled = false; rescan.textContent = "Rescan sent mail"; }
    } }, "Rescan sent mail");

  fill($app, 
    topbar("Settings", { back: "#/brief" }),
    params.error && h("div", { class: "notice warn" }, params.error),
    h("div", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "Accounts")),
      accountsCard(accounts, { reload: () => renderSettings([], {}) }),
      h("div", { class: "row-gap", style: "margin-top:10px" },
        h("a", { class: "btn small", href: "/api/auth/google/start" }, "+ Connect a Gmail account"),
        h("span", { class: "small muted" }, "Outlook and IMAP arrive in Phase 2."))),
    h("div", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "What matters to you")),
      form),
    h("div", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "What it has learned")),
      h("div", { class: "card pad" },
        h("p", { style: "margin-top:0" }, `${profile.correspondentCount} people you've written to are treated as important.`),
        profile.topCorrespondents.length ? h("p", { class: "small muted" }, profile.topCorrespondents.slice(0, 8).map((c) => c.email).join(", ")) : null,
        rescan,
        h("div", { class: "label" }, "Sender rules you've taught"),
        overrides.length ? h("div", {}, overrides.map(([key, bucket]) => h("div", { class: "row-gap", style: "justify-content:space-between;padding:6px 0;border-top:1px solid var(--line)" },
          h("span", { style: "overflow-wrap:anywhere" }, `${key} → ${bucket}`),
          h("button", { class: "btn small", onclick: async () => { await api("profile/overrides", { method: "DELETE", body: { key } }); renderSettings([], {}); } }, "Remove"))))
          : h("p", { class: "small muted", style: "margin:0" }, "None yet. Use “Always important / Always junk” on any email."))),
    h("div", { class: "section" },
      h("button", { class: "btn", onclick: async () => { await api("logout", { method: "POST" }); location.hash = "#/login"; } }, "Sign out")),
  );
}

// ── onboarding ────────────────────────────────────────────────────────

async function renderOnboarding(_args, params) {
  const [profile, { accounts }] = await Promise.all([api("profile"), api("accounts")]);
  const step = !accounts.length ? 1 : !profile.sentAnalyzedAt ? 2 : !profile.onboarded ? 3 : 4;
  const steps = h("div", { class: "steps", "aria-label": `Step ${Math.min(step, 3)} of 3` }, [1, 2, 3].map((n) => h("i", { class: n <= step ? "on" : "" })));
  const shell = (...children) => fill($app, topbar("Set up Inbox Pilot", accounts.length && profile.onboarded ? { back: "#/brief" } : {}), steps, ...children);

  if (step === 1) {
    return shell(
      h("section", { class: "hero" }, h("h2", {}, "Connect your Gmail"), h("p", {}, "You'll sign in on Google's own page. Inbox Pilot never sees your password, and you can revoke access any time from your Google account.")),
      params.error && h("div", { class: "notice warn" }, params.error),
      h("div", { class: "card pad" },
        h("div", { class: "field", style: "margin-top:0" }, h("label", { for: "label" }, "Label for this account"), h("input", { type: "text", id: "label", placeholder: "Personal, Med spa, Kids' school…" })),
        h("button", { class: "btn primary block", style: "margin-top:16px", onclick: () => {
            const label = document.getElementById("label").value;
            location.href = `/api/auth/google/start?label=${encodeURIComponent(label)}`;
          } }, "Continue with Google")),
      h("p", { class: "small muted" }, "Permission requested: read, label, and move mail to trash. Inbox Pilot cannot permanently delete anything."));
  }

  if (step === 2) {
    const btn = h("button", { class: "btn primary block", onclick: async () => {
        btn.disabled = true;
        btn.replaceChildren(h("span", { class: "spin" }), "Reading your sent folder…");
        try {
          await api("profile/analyze-sent", { method: "POST" });
          renderOnboarding([], {});
        } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = "Learn from my sent mail"; }
      } }, "Learn from my sent mail");
    return shell(
      params.connected && h("div", { class: "notice" }, `Connected ${params.connected}.`),
      h("section", { class: "hero" }, h("h2", {}, "If you write to them, they matter"), h("p", {}, "Inbox Pilot looks at who you've sent mail to (just the To and Cc lines, not the content) and treats those people as important.")),
      h("div", { class: "card pad" }, btn),
      h("p", { class: "small muted" }, h("a", { href: "/api/auth/google/start" }, "Connect another Gmail account first")));
  }

  if (step === 3) {
    const form = h("form", { onsubmit: async (e) => {
        e.preventDefault();
        const submit = form.querySelector("button[type=submit]");
        submit.disabled = true;
        submit.replaceChildren(h("span", { class: "spin" }), "Sorting your inbox…");
        try {
          await api("profile", { method: "PUT", body: { ...readProfileForm(form), onboarded: true } });
          const r = await api("triage/run", { method: "POST" });
          location.hash = "#/brief";
          if (r.status?.counts) toast(`First brief ready: ${r.status.counts.important} important, ${r.status.counts.possibly} unsure`);
        } catch (err) { toast(err.message); submit.disabled = false; submit.textContent = "Build my first brief"; }
      } },
      h("div", { class: "card pad" }, ...profileFields(profile)),
      h("div", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, "Daily brief")), h("div", { class: "card pad" }, ...briefTimeFields(profile))),
      h("button", { class: "btn primary block", type: "submit", style: "margin-top:16px" }, "Build my first brief"));
    return shell(
      h("section", { class: "hero" },
        h("h2", {}, "What must never be missed?"),
        h("p", {}, `Found ${profile.correspondentCount} people you write to. Now tell it the rest. Everything here can be changed later in Settings.`)),
      form);
  }

  location.hash = "#/brief";
}

// ── boot ──────────────────────────────────────────────────────────────

(async () => {
  try {
    const session = await api("session");
    if (!session.signedIn && location.hash !== "#/login") {
      location.hash = "#/login"; // hashchange will render
      return;
    }
  } catch {}
  route();
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
