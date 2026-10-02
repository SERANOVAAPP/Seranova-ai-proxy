import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress, parseAddressList, extractBody, htmlToText, stripQuoted } from "../lib/mail-parse.js";

test("parseAddress handles names, quotes, and bare addresses", () => {
  assert.deepEqual(parseAddress('"Whitfield, Dana" <DW@Law.com>'), { name: "Whitfield, Dana", email: "dw@law.com" });
  assert.deepEqual(parseAddress("solo@x.com"), { name: "solo@x.com", email: "solo@x.com" });
  assert.deepEqual(parseAddress(""), { name: "", email: "" });
});

test("parseAddressList splits on commas outside quotes", () => {
  const list = parseAddressList('"Bell, Marcus" <m@b.com>, Dana <d@l.com>,x@y.com');
  assert.deepEqual(list.map((a) => a.email), ["m@b.com", "d@l.com", "x@y.com"]);
  assert.equal(list[0].name, "Bell, Marcus");
});

test("extractBody prefers plain text, falls back to stripped HTML", () => {
  const b64 = (s) => Buffer.from(s).toString("base64url");
  const both = { parts: [{ mimeType: "text/html", body: { data: b64("<b>html</b>") } }, { mimeType: "text/plain", body: { data: b64("plain") } }] };
  assert.equal(extractBody(both), "plain");
  const htmlOnly = { parts: [{ mimeType: "text/html", body: { data: b64("<style>x{}</style><p>Hello&nbsp;there</p><p>Bye</p>") } }] };
  assert.equal(extractBody(htmlOnly), "Hello there\nBye");
});

test("htmlToText decodes entities", () => {
  assert.equal(htmlToText("Tom &amp; Jerry &#39;s"), "Tom & Jerry 's");
});

test("stripQuoted removes reply history", () => {
  assert.equal(stripQuoted("Sounds good\n\nOn Tue, Oct 1, 2026 Bob wrote:\n> old"), "Sounds good");
});
