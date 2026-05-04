import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  // CORS headers — required for the Hub PWA to call this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Vercel makes the dynamic [id] portion available as req.query.id
  const jobId = req.query.id;

  if (!jobId || typeof jobId !== "string") {
    return res.status(400).json({ error: "Missing job id" });
  }

  // Basic sanity check — our IDs all start with "tp_"
  if (!jobId.startsWith("tp_")) {
    return res.status(400).json({ error: "Invalid job id format" });
  }

  try {
    const job = await kv.get(`tpjob:${jobId}`);

    if (!job) {
      // Either the ID is wrong or the job expired (>24h old)
      return res.status(404).json({
        error: "Job not found",
        jobId,
        hint: "Job may have expired (jobs expire after 24 hours) or the id is incorrect.",
      });
    }

    // Pass through whatever Redis has stored for this job.
    // Possible statuses: queued, running, completed, failed
    return res.status(200).json({
      jobId,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      // Only include heavy fields when relevant
      result: job.status === "completed" ? job.result : undefined,
      error: job.status === "failed" ? job.error : undefined,
    });
  } catch (err) {
    console.error("[jobs/[id]] Error reading job:", err);
    return res.status(500).json({
      error: "Failed to read job state",
      details: err.message,
    });
  }
}
