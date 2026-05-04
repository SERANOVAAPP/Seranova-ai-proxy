import { kv } from "@vercel/kv";
import { inngest } from "../inngest.js";

// Generate a short unique ID like "tp_8h3kx7q1p9"
function makeJobId() {
  return "tp_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
}

const JOB_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export default async function handler(req, res) {
  // CORS headers — required for the Hub PWA to call this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = req.body;

    // Sanity check the payload looks like an Anthropic request
    if (!payload || !payload.model || !payload.messages) {
      return res.status(400).json({
        error: "Invalid payload",
        details: "Body must include model and messages fields",
      });
    }

    const jobId = makeJobId();
    const now = Date.now();

    // Initialize the job record in Redis
    await kv.set(
      `tpjob:${jobId}`,
      {
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
      { ex: JOB_TTL_SECONDS }
    );

    // Fire the Inngest event — this is what triggers the worker
    await inngest.send({
      name: "tp/generate.requested",
      data: {
        jobId,
        payload,
      },
    });

    // Return the jobId immediately. Phone will poll for the result.
    return res.status(202).json({
      jobId,
      status: "queued",
      pollUrl: `/api/jobs/${jobId}`,
    });
  } catch (err) {
    console.error("[jobs/start] Error:", err);
    return res.status(500).json({
      error: "Failed to start job",
      details: err.message,
    });
  }
}
