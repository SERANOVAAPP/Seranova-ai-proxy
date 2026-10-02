import { serve } from "inngest/next";
import { inngest, functions } from "../lib/inngest.js";

// Inngest's servers call this endpoint to run background jobs. Requests
// are verified with INNGEST_SIGNING_KEY.
export default serve({ client: inngest, functions });
