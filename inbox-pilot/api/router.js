import router from "../lib/routes.js";

// Every /api/* request (except /api/inngest) is rewritten here by vercel.json.
export default function handler(req, res) {
  return router.handle(req, res);
}
