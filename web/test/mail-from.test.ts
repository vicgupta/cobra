import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_MAIL_FROM, mailFrom } from "../lib/mail-from";

test("system email sender: danny@kantsy.com by default, COBRA_MAIL_FROM overrides, sent on every message", () => {
  assert.equal(DEFAULT_MAIL_FROM, "danny@kantsy.com");
  assert.equal(mailFrom(() => undefined), "danny@kantsy.com");
  assert.equal(mailFrom(() => "  "), "danny@kantsy.com");
  assert.equal(mailFrom((k) => (k === "COBRA_MAIL_FROM" ? "ops@example.com" : undefined)), "ops@example.com");
  const src = readFileSync(new URL("../lib/mail.ts", import.meta.url), "utf8");
  assert.match(src, /JSON\.stringify\(\{ from: mailFrom\(secret\), to, subject, body \}\)/);
  assert.ok(!/cobra@kantsy\.com/.test(src));
});
