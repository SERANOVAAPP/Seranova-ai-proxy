import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBatch, summarize, setAiClient } from "../lib/ai.js";
import { DEFAULT_PROFILE } from "../lib/profile.js";

function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => (calls.push(req), reply(req)) } },
  };
}
const textReply = (obj) => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(obj) }] });
const msg = { id: "a:1", from: { name: "Ms A", email: "a@school.org" }, to: [{ email: "k@x.com" }], subject: "Slip due", snippet: "Please sign", body: "Please sign the slip by Friday.", date: Date.parse("2026-10-02T10:00:00Z"), attachments: [] };

test("classifyBatch sends a schema-constrained request and keys results by id", async () => {
  const client = fakeClient(() => textReply({ results: [{ id: "a:1", bucket: "important", confidence: 0.9, needs_reply: false, reason: "school" }] }));
  setAiClient(client);
  const out = await classifyBatch([{ ...msg, hints: ["School sender"] }], { ...DEFAULT_PROFILE, neverMiss: ["Lincoln"] });
  assert.equal(out["a:1"].bucket, "important");
  const req = client.calls[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(req.output_config.effort, "low");
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.match(req.system[0].text, /Never miss: Lincoln/);
  assert.match(req.system[0].text, /untrusted/);
  assert.equal(req.thinking, undefined);
  assert.equal(req.temperature, undefined);
});

test("summaries degrade gracefully on refusal", async () => {
  setAiClient(fakeClient(() => ({ stop_reason: "refusal", content: [] })));
  const s = await summarize([msg], DEFAULT_PROFILE, { today: "Friday, 10/02/2026" });
  assert.match(s.summary, /declined/);
  assert.deepEqual(s.deadlines, []);
});

test("thread summaries include earlier messages and today's date", async () => {
  const client = fakeClient(() => textReply({ one_line: "x", summary: "y", thread_so_far: "z", needs_reply: true, reply_reason: "q", urgency: "today", deadlines: [] }));
  setAiClient(client);
  await summarize([{ ...msg, body: "first message" }, { ...msg, body: "second message" }], DEFAULT_PROFILE, { today: "Friday, 10/02/2026" });
  const user = client.calls[0].messages[0].content;
  assert.match(user, /thread of 2 messages/);
  assert.match(user, /first message[\s\S]*second message/);
  assert.match(user, /Today is Friday/);
});
