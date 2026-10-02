import { Inngest } from "inngest";
import { runTriage } from "./triage.js";
import { loadProfile } from "./profile.js";
import { listAccounts } from "./accounts.js";
import { briefDueDate } from "./schedule.js";
import { getStore } from "./store.js";

// ── Background jobs ───────────────────────────────────────────────────
// The id must stay stable across deploys. It is separate from the Staff
// Hub's Inngest app so the two never interfere.
export const inngest = new Inngest({ id: "inbox-pilot" });

export const TRIAGE_EVENT = "inbox/triage.requested";
const LAST_BRIEF_KEY = "ip:lastBriefDate";

export const triageFunction = inngest.createFunction(
  {
    id: "triage-run",
    retries: 2,
    concurrency: { limit: 1 }, // never two triage runs at once
    timeouts: { finish: "30m" },
  },
  { event: TRIAGE_EVENT },
  async ({ event, step }) =>
    runTriage({
      reason: event.data?.reason || "manual",
      step: (name, fn) => step.run(name, fn),
    })
);

// Every 15 minutes: is it brief time yet (in your timezone)?
export const briefScheduler = inngest.createFunction(
  { id: "brief-scheduler" },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const due = await step.run("check-due", async () => {
      const [profile, accounts] = await Promise.all([loadProfile(), listAccounts()]);
      if (!profile.onboarded || accounts.length === 0) return null;
      const store = await getStore();
      return briefDueDate(profile, new Date(), await store.get(LAST_BRIEF_KEY));
    });
    if (!due) return { skipped: true };
    await step.run("mark-sent", async () => (await getStore()).set(LAST_BRIEF_KEY, due));
    await step.sendEvent("start-brief", { name: TRIAGE_EVENT, data: { reason: "daily-brief" } });
    return { started: due };
  }
);

export const functions = [triageFunction, briefScheduler];

export function inngestConfigured() {
  return Boolean(process.env.INNGEST_EVENT_KEY);
}
