import { Inngest } from "inngest";
import { serve } from "inngest/vercel";
import { kv } from "@vercel/kv";

// ── Inngest client ────────────────────────────────────────────────────
// This identifies our app to Inngest. The id MUST stay stable across
// deploys or Inngest will treat each deploy as a different app.
export const inngest = new Inngest({ id: "seranova-staff-hub" });

// ── Job storage helpers ───────────────────────────────────────────────
// Jobs live in Redis under keys like "tpjob:abc123". We store the
// entire job state as JSON so the phone can poll one key for everything.
const JOB_TTL_SECONDS = 60 * 60 * 24; // 24 hours

async function setJob(jobId, data) {
  await kv.set(`tpjob:${jobId}`, data, { ex: JOB_TTL_SECONDS });
}

async function getJob(jobId) {
  return await kv.get(`tpjob:${jobId}`);
}

// ── The worker function ───────────────────────────────────────────────
// Triggered by an event called "tp/generate.requested".
// Calls Anthropic, stores the result in Redis, marks the job complete.
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
    const { jobId, payload } = event.data;

    // Step 1: Mark the job as running
    await step.run("mark-running", async () => {
      const current = (await getJob(jobId)) || {};
      await setJob(jobId, {
        ...current,
        status: "running",
        startedAt: Date.now(),
      });
    });

    // Step 2: Call Anthropic. This is the long-running step.
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

    // Step 3: Store the completed result in Redis
    await step.run("save-result", async () => {
      const current = (await getJob(jobId)) || {};
      await setJob(jobId, {
        ...current,
        status: "completed",
        completedAt: Date.now(),
        result,
      });
    });

    return { jobId, status: "completed" };
  }
);

// ── HTTP endpoint at /api/inngest ─────────────────────────────────────
// Inngest's servers POST to this endpoint to invoke our function.
// The signing key in env vars verifies these requests are legitimate.
export default serve({
  client: inngest,
  functions: [generateTreatmentPlan],
});
