import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { encrypt, decrypt, sign, verify } from "../lib/crypto.js";
import { briefDueDate } from "../lib/schedule.js";

test("encrypt/decrypt round-trips and detects tampering", () => {
  const sealed = encrypt("1//refresh-token");
  assert.notEqual(sealed, "1//refresh-token");
  assert.equal(decrypt(sealed), "1//refresh-token");
  const parts = sealed.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decrypt(parts.join(".")));
});

test("signed tokens verify, expire, and reject forgery", () => {
  const t = sign({ user: "owner" }, 60);
  assert.equal(verify(t).user, "owner");
  assert.equal(verify(t.slice(0, -2) + "xx"), null);
  assert.equal(verify(sign({ user: "owner" }, -1)), null);
});

test("brief is due after brief time, once per local day", () => {
  const p = { timezone: "America/Los_Angeles", briefTime: "07:00", weekendBrief: false };
  // 2026-10-02 is a Friday. 13:59Z = 06:59 PDT, 14:00Z = 07:00 PDT.
  assert.equal(briefDueDate(p, new Date("2026-10-02T13:59:00Z"), null), null);
  assert.equal(briefDueDate(p, new Date("2026-10-02T14:00:00Z"), null), "2026-10-02");
  assert.equal(briefDueDate(p, new Date("2026-10-02T20:00:00Z"), "2026-10-02"), null);
  assert.equal(briefDueDate(p, new Date("2026-10-03T16:00:00Z"), "2026-10-02"), null, "Saturday skipped");
  assert.equal(briefDueDate({ ...p, weekendBrief: true }, new Date("2026-10-03T16:00:00Z"), "2026-10-02"), "2026-10-03");
});
