import { kv } from “@vercel/kv”;
import { inngest } from “../inngest.js”;

// Generate a short unique ID like “tp_8h3kx7q1p9”
function makeJobId() {
return “tp_” + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
}

const JOB_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export default async function handler(req, res) {
// CORS headers — required for the Hub PWA to call this endpoint
res.setHeader(“Access-Control-Allow-Origin”, “*”);
res.setHeader(“Access-Control-Allow-Methods”, “POST, OPTIONS”);
res.setHeader(“Access-Control-Allow-Headers”, “Content-Type”);
res.setHeader(“Access-Control-Max-Age”, “86400”);

if (req.method === “OPTIONS”) {
return res.status(200).end();
}

if (req.method !== “POST”) {
return res.status(405).json({ error: “Method not allowed” });
}

let stage = “init”;
try {
stage = “parse-body”;
const payload = req.body;

```
// Sanity check the payload looks like an Anthropic request
if (!payload || !payload.model || !payload.messages) {
  return res.status(400).json({
    error: "Invalid payload",
    details: "Body must include model and messages fields",
  });
}

// Rough size estimate for logging / future limits
const approxBytes = JSON.stringify(payload).length;

stage = "make-id";
const jobId = makeJobId();
const now = Date.now();

// Step 1: Store the payload in Redis under its own key.
// We do this so the Inngest event can be tiny (just the jobId).
// Inngest events are limited (256KB free tier, 3MB on paid plans),
// but treatment-plan payloads with photos can be 1-3MB.
stage = "store-payload";
await kv.set(`tppayload:${jobId}`, payload, { ex: JOB_TTL_SECONDS });

// Step 2: Initialize the job state record in Redis
stage = "init-job-state";
await kv.set(
  `tpjob:${jobId}`,
  {
    status: "queued",
    createdAt: now,
    updatedAt: now,
    approxBytes,
  },
  { ex: JOB_TTL_SECONDS }
);

// Step 3: Fire the Inngest event with ONLY the jobId.
// The worker will read the full payload from Redis.
stage = "send-inngest-event";
await inngest.send({
  name: "tp/generate.requested",
  data: { jobId },
});

// Return the jobId immediately. Phone will poll for the result.
return res.status(202).json({
  jobId,
  status: "queued",
  pollUrl: `/api/jobs/${jobId}`,
});
```

} catch (err) {
// Log full error server-side, return safe info to client
console.error(`[jobs/start] Error at stage='${stage}':`, err);
return res.status(500).json({
error: “Failed to start job”,
stage,
details: (err && err.message) || String(err),
});
}
}
