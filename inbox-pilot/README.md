# Inbox Pilot

AI email triage: finds what matters across your inboxes, summarizes it, and keeps the junk out of your way.

This folder is **Phase 1** of the spec (read and triage), built as a personal tool:

- Connect Gmail accounts through Google's own sign-in (no passwords stored; tokens encrypted at rest)
- Learns who matters from your sent mail (To/Cc lines only)
- Onboarding interview: never-miss list, school and kids, work domains, urgent topics, always-noise
- Four buckets: **Important**, **Possibly important**, **Subscriptions**, **Junk**. Anything with a real sign of importance is never silently buried.
- Daily brief: one-line AI summaries, deadline callouts, and **Respond / Ignore / Trash** on every email
- Summary first: 2–3 sentence summary, thread recap, "why it's here", and the original email loaded live from Gmail only when you ask
- Learning loop: "Always important / Always junk" per sender or whole domain, plus your everyday Respond/Trash choices adjust future scoring
- Cleanup view: junk and subscriptions grouped by sender with counts (bulk delete + unsubscribe come in Phase 2)
- Installable on your phone's home screen (PWA), light and dark mode

Also included early from Phase 2: more than one Gmail account, each with its own label and color, in one unified brief.

## Try it in 10 seconds (no setup)

```bash
cd inbox-pilot
npm install
npm run demo        # http://localhost:3000, password: demo
```

Demo mode uses a realistic fake mailbox (school, contractor, attorney, bank, Old Navy promos, spam…) and an offline stand-in for the AI. Set `ANTHROPIC_API_KEY` before `npm run demo` to see real Claude summaries on the fake mailbox.

`npm test` runs the test suite (rules, parsing, encryption, schedule, the whole triage pipeline, and the exact Claude request shape).

## How it works

```
Gmail (metadata only) ─▶ rules pass ─▶ AI classify (borderline only) ─▶ AI summary (brief-worthy only) ─▶ Redis
```

1. **Rules pass** (`lib/rules.js`, free): your never-miss / noise lists, sender rules you taught it, people you write to, school/work/money/legal/medical signals, unsubscribe headers, Gmail's categories. Clear cases are decided here.
2. **Classification pass** (`lib/ai.js`): only the unclear emails, 25 per request, sender + subject + preview only.
3. **Summary pass**: only emails that made the brief. The newest message stands for its thread.
4. **What's stored**: sender, subject, bucket, summary, deadlines, your decisions. **Never the email body.** The original is fetched live from Gmail when you tap "Show original".

The pipeline runs as an Inngest job (each step retried independently). A 15-minute scheduler builds the brief at your chosen time in your time zone. Without Inngest it runs inline when you tap refresh.

| Path | What |
|---|---|
| `api/router.js` | Every `/api/*` route (one function, to stay under Vercel Hobby's function limit) |
| `api/inngest.js` | Background jobs endpoint |
| `lib/` | Gmail client, rules, AI, pipeline, profile/learning, storage |
| `public/` | The app (plain JS, no build step) |
| `dev/` | Local server, fake mailbox, offline AI |

## Deploy (about 30 minutes, once)

### 1. Vercel project

Create a **new** Vercel project from this repo with **Root Directory = `inbox-pilot`** (Framework: Other). It is fully separate from the Staff Hub proxy deployed from the repo root. Note the URL, e.g. `https://inbox-pilot-xyz.vercel.app`.

In the project's **Storage** tab, create/connect a KV (Upstash Redis) store. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`. (Sharing the Staff Hub's Redis is also fine; every key here starts with `ip:`.)

### 2. Google Cloud (Gmail access)

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project ("Inbox Pilot").
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → User type **External** → app name, your email → Scopes: add `.../auth/gmail.modify` → Test users: add every Gmail address you'll connect.
4. **Publishing status: click "Publish app"** (to "In production"). You'll see an "unverified app" warning when signing in; click *Advanced → Go to Inbox Pilot*. This is fine for personal use (up to 100 users). If you leave it in *Testing*, Google expires your sign-in every 7 days.
5. **Credentials → Create credentials → OAuth client ID** → *Web application* → Authorized redirect URI: `https://YOUR-APP.vercel.app/api/auth/google/callback` (add `http://localhost:3000/api/auth/google/callback` too for local dev).
6. Copy the client ID and secret.

### 3. Inngest (daily brief + background runs)

In the Vercel project: **Integrations → Inngest** (or create an app at inngest.com). It sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`. After deploying, sync the app URL `https://YOUR-APP.vercel.app/api/inngest` in the Inngest dashboard. The app id is `inbox-pilot`, separate from the Staff Hub's.

### 4. Environment variables

In Vercel → Settings → Environment Variables (see `.env.example`):

`APP_PASSWORD`, `APP_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ANTHROPIC_API_KEY` (+ the KV and Inngest ones from above). Redeploy.

### 5. First run

Open the app → sign in → connect Gmail → "Learn from my sent mail" → answer the interview → **Build my first brief**. On iPhone: Share → *Add to Home Screen*.

## Costs

- Claude: defaults to `claude-opus-5-5` at low effort. Only borderline emails are classified and only brief-worthy emails are summarized, so a typical day is a few cents. Set `AI_MODEL=claude-haiku-4-5` to cut that further.
- Vercel, KV and Inngest free tiers cover personal use.

## Privacy and safety

- Google sign-in only; the refresh token is AES-256-GCM encrypted with a key derived from `APP_SECRET`.
- Gmail scope `gmail.modify` can read, label, and trash, but **cannot permanently delete**. Trash is recoverable for 30 days in Gmail.
- Email bodies are never stored. Summaries, sender rules and your decisions are; handled items are forgotten after 14 days, unread junk after 45.
- Email text is treated as untrusted by the AI prompts (an email can't instruct the AI), and is rendered in the app as plain text only.
- Revoke access any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## What's next (from the spec)

- **Phase 2**: Outlook (Microsoft sign-in) and IMAP accounts; bulk delete by sender across accounts; one-tap unsubscribe
- **Phase 3**: AI reply drafts in your voice for everything you mark Respond; approve / "shorter" / "firmer"; send from the right account
- **Phase 4–5**: Audio brief (device voice first), then hands-free voice commands
- **Phase 6**: Calendar export of deadlines, never-miss push notifications, snooze, weekly trust report
