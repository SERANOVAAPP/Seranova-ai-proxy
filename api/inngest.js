import { Inngest } from "inngest";
import { serve } from "inngest/next";
import { kv } from "@vercel/kv";

// ── Inngest client ────────────────────────────────────────────────────
// This identifies our app to Inngest. The id MUST stay stable across
// deploys or Inngest will treat each deploy as a different app.
export const inngest = new Inngest({ id: "seranova-staff-hub" });

// ── Job storage helpers ───────────────────────────────────────────────
// Jobs live in Redis under keys like "tpjob:abc123". We store the
// entire job state as JSON so the phone can poll one key for everything.
// The full request payload lives at "tppayload:abc123" (separate key
// because it can be 1-3MB and we don’t want to read/write it on every
// status update).
const JOB_TTL_SECONDS = 60 * 60 * 24; // 24 hours

async function setJob(jobId, data) {
await kv.set(`tpjob:${jobId}`, data, { ex: JOB_TTL_SECONDS });
}

async function getJob(jobId) {
return await kv.get(`tpjob:${jobId}`);
}

async function getPayload(jobId) {
return await kv.get(`tppayload:${jobId}`);
}

async function deletePayload(jobId) {
// Best-effort cleanup. Failure is non-fatal.
try {
await kv.del(`tppayload:${jobId}`);
} catch (e) {
console.error(`[inngest] Failed to delete payload for ${jobId}:`, e);
}
}

// ── The worker function ───────────────────────────────────────────────
// Triggered by an event called "tp/generate.requested" (data: { jobId }).
// Reads the payload from Redis, calls Anthropic, stores the result.
export const generateTreatmentPlan = inngest.createFunction(
{
id: "generate-treatment-plan",
retries: 2,
// Treatment plans with 6 photos can take 60-120 seconds.
// Give the function plenty of headroom.
timeouts: { start: "5m", finish: "10m" },
},
{ event: "tp/generate.requested" },
async ({ event, step }) => {
const { jobId } = event.data;
if (!jobId) {
throw new Error("Event data missing jobId");
}

```
// Step 1: Load the request payload from Redis.
// (It was stored there by /api/jobs/start because Inngest events
// have payload size limits and the request can be up to several MB.)
const payload = await step.run("load-payload", async () => {
  const p = await getPayload(jobId);
  if (!p) {
    throw new Error(
      `No payload found for job ${jobId}. ` +
        `It may have expired or never been stored.`
    );
  }
  return p;
});

// Step 2: Mark the job as running
await step.run("mark-running", async () => {
  const current = (await getJob(jobId)) || {};
  await setJob(jobId, {
    ...current,
    status: "running",
    startedAt: Date.now(),
  });
});

// Step 3: Call Anthropic. This is the long-running step.
const result = await step.run("call-anthropic", async () => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Throwing here will trigger Inngest's automatic retry logic
    throw new Error(
      `Anthropic returned ${response.status}: ${errorText.slice(0, 500)}`
    );
  }

  return await response.json();
});

// Step 4: Store the completed result in Redis
await step.run("save-result", async () => {
  const current = (await getJob(jobId)) || {};
  await setJob(jobId, {
    ...current,
    status: "completed",
    completedAt: Date.now(),
    result,
  });
});

// Step 5: Clean up the (possibly large) payload key now that we're done.
// The job state record at tpjob:{jobId} still holds the result for
// the phone to poll; the payload itself is no longer needed.
await step.run("cleanup-payload", async () => {
  await deletePayload(jobId);
});

return { jobId, status: "completed" };
```

}
);

// ── HTTP endpoint at /api/inngest ─────────────────────────────────────
// Inngest’s servers POST to this endpoint to invoke our function.
// The signing key in env vars verifies these requests are legitimate.
export default serve({
client: inngest,
functions: [generateTreatmentPlan],
});
