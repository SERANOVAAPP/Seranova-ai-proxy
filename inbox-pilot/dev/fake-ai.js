// A stand-in for Claude that needs no API key. It is deliberately simple:
// it trusts the rules engine's hints and writes extractive summaries. Real
// runs use lib/ai.js.

export async function classifyBatch(messages) {
  const out = {};
  for (const m of messages) {
    const hints = (m.hints || []).join(" ");
    let bucket = "possibly";
    let confidence = 0.6;
    if (/school|deadline|written to|work domain|kids/i.test(hints)) [bucket, confidence] = ["important", 0.8];
    else if (/promotional|promotions|unsubscribe/i.test(hints) && !/medical|money|legal/i.test(hints)) [bucket, confidence] = ["subscriptions", 0.8];
    out[m.id] = { id: m.id, bucket, confidence, needs_reply: /\?/.test(m.preview), reason: "Demo classifier (no API key)" };
  }
  return out;
}

export async function summarize(thread) {
  const last = thread[thread.length - 1];
  const text = (last.body || last.snippet).replace(/\s+/g, " ").trim();
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const dateMatch = text.match(/\b(?:by|due|on)\s+((?:this\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:,\s*\w+ \d+)?|\w+ \d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
  return {
    one_line: last.subject,
    summary: `${last.from.name} writes: ${sentences.slice(0, 2).join(" ").trim()}`,
    thread_so_far: thread.length > 1 ? `${thread.length} messages so far. Earlier: ${thread[0].body.slice(0, 120)}` : "",
    needs_reply: /\?|confirm|let me know|rsvp|reply/i.test(text),
    reply_reason: /\?|confirm|let me know|rsvp|reply/i.test(text) ? "They asked you a question" : "Informational",
    urgency: /today|tonight|tomorrow|friday|by wednesday|thursday/i.test(text) ? "this_week" : "whenever",
    deadlines: dateMatch ? [{ what: last.subject, due_date: "", due_text: dateMatch[0] }] : [],
  };
}
