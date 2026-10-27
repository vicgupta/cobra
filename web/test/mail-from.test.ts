import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_DIGEST_FROM, DEFAULT_MAIL_FROM, digestFrom, mailFrom, senderFor } from "../lib/mail-from";

test("system email sender: danny@kantsy.com by default, COBRA_MAIL_FROM overrides, sent on every message", () => {
  assert.equal(DEFAULT_MAIL_FROM, "danny@kantsy.com");
  assert.equal(mailFrom(() => undefined), "danny@kantsy.com");
  assert.equal(mailFrom(() => "  "), "danny@kantsy.com");
  assert.equal(mailFrom((k) => (k === "COBRA_MAIL_FROM" ? "ops@example.com" : undefined)), "ops@example.com");
  const src = readFileSync(new URL("../lib/mail.ts", import.meta.url), "utf8");
  assert.match(src, /const from = senderFor\(secret, opts\.sender\)/);
  assert.match(src, /JSON\.stringify\(\{ from, to, subject, body \}\)/);
  assert.ok(!/cobra@kantsy\.com/.test(src));
});

test("digest sender: cobra@kantsy.com by default, COBRA_DIGEST_FROM overrides, COBRA_MAIL_FROM unaffected", () => {
  assert.equal(DEFAULT_DIGEST_FROM, "cobra@kantsy.com");
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assert.equal(digestFrom(env({})), "cobra@kantsy.com");
  assert.equal(digestFrom(env({ COBRA_MAIL_FROM: "ops@example.com" })), "cobra@kantsy.com", "mail-from does not leak into the digest");
  assert.equal(digestFrom(env({ COBRA_DIGEST_FROM: "d@example.com" })), "d@example.com");
  assert.equal(senderFor(env({ COBRA_DIGEST_FROM: "d@example.com", COBRA_MAIL_FROM: "ops@example.com" }), undefined), "ops@example.com", "password resets etc. keep COBRA_MAIL_FROM");
  assert.equal(senderFor(env({}), "digest"), "cobra@kantsy.com");
  for (const f of ["../lib/notifications.ts", "../lib/team-notifications.ts"]) assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /DIGEST = \{ sender: "digest" \}/, f);
  assert.doesNotMatch(readFileSync(new URL("../app/api/auth/forgot-password/route.ts", import.meta.url), "utf8"), /digest/);
});
