import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminEmailFrom, gate, isSystemAdmin, matchesAdmin } from "../lib/admin/gate";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { createSession, getSessionUser } from "../lib/auth/sessions";
import * as m from "../lib/admin/metrics";

const tmp = () => mkdtempSync(join(tmpdir(), "cobra-admin-"));

test("adminEmailFrom: KEY=\"value\", quotes, comments, last wins, missing", () => {
  assert.equal(adminEmailFrom('A="1"\nCOBRA_ADMIN_EMAIL="Boss@Example.com"\n'), "Boss@Example.com");
  assert.equal(adminEmailFrom("COBRA_ADMIN_EMAIL=plain@x.io"), "plain@x.io");
  assert.equal(adminEmailFrom("#COBRA_ADMIN_EMAIL=\"x@y.z\""), "");
  assert.equal(adminEmailFrom('COBRA_ADMIN_EMAIL="a@b.c"\nCOBRA_ADMIN_EMAIL=""'), "");
  assert.equal(adminEmailFrom("OTHER=1"), "");
  assert.equal(adminEmailFrom("NOT_COBRA_ADMIN_EMAIL=a@b.c"), "");
});

test("matchesAdmin: case-insensitive exact match; blank means nobody", () => {
  assert.ok(matchesAdmin("boss@example.com", "Boss@Example.com"));
  assert.ok(!matchesAdmin("boss@example.com.evil", "boss@example.com"));
  assert.ok(!matchesAdmin("xboss@example.com", "boss@example.com"));
  assert.ok(!matchesAdmin("", ""));
  assert.ok(!matchesAdmin("boss@example.com", "   "));
  assert.ok(!matchesAdmin(null, "boss@example.com"));
});

test("gate: admin gets regular app + /admin, non-admin 404 on /admin, blank env, missing file; re-read on every call", () => {
  const d = tmp();
  try {
    const f = join(d, "cobra.env");
    writeFileSync(f, 'COBRA_ENV_FILE="x"\nCOBRA_ADMIN_EMAIL="Boss@Example.com"\n');
    assert.equal(gate("boss@example.com", "admin", f), "ok");
    assert.equal(gate("BOSS@example.com", "user", f), "ok"); // admin keeps the regular app
    assert.equal(gate("member@example.com", "admin", f), "not-found");
    assert.equal(gate("member@example.com", "user", f), "ok");
    // Changing the file applies immediately (no restart, no cache).
    writeFileSync(f, 'COBRA_ADMIN_EMAIL=""\n');
    assert.equal(gate("boss@example.com", "admin", f), "not-found");
    assert.equal(gate("boss@example.com", "user", f), "ok");
    writeFileSync(f, "OTHER=1\n");
    assert.ok(!isSystemAdmin("boss@example.com", f));
    assert.equal(gate("boss@example.com", "admin", join(d, "missing.env")), "not-found");
    // process.env is not a fallback.
    process.env.COBRA_ADMIN_EMAIL = "boss@example.com";
    assert.ok(!isSystemAdmin("boss@example.com", f));
    delete process.env.COBRA_ADMIN_EMAIL;
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("admin metrics: cross-tenant counts, sessions without token hashes, end any session", () => {
  const db = openDb(":memory:");
  const a = createUser(db, { email: "a@x.io", tenant: "default", tenantName: "Default", role: "admin", password: "pw-1234567890" });
  const b = createUser(db, { email: "b@y.io", tenant: "other", tenantName: "Other", role: "member", password: "pw-1234567890" });
  const now = Date.now();
  const tokA = createSession(db, a, now);
  createSession(db, b, now);
  const o = m.overview(db, now);
  assert.equal(o.tenants, 2);
  assert.equal(o.users, 2);
  assert.equal(o.activeSessions, 2);
  assert.equal(o.schemaVersion, 14);
  assert.equal(o.systemTemplates, 0); // seeding happens in getDb(), not openDb()
  assert.deepEqual(m.tenants(db).map((t) => [t.slug, t.users]), [["default", 1], ["other", 1]]);
  const s = m.sessions(db, now);
  assert.equal(s.length, 2);
  assert.ok(s.every((r) => !("id" in r)), "token hash never selected");
  const mine = s.find((r) => r.email === "a@x.io")!;
  assert.ok(m.endAnySession(db, mine.public_id));
  assert.ok(!m.endAnySession(db, mine.public_id));
  assert.equal(getSessionUser(db, tokA.token, now), null);
  assert.equal(m.rateLimits(db, now).limits.length, 5);
  assert.deepEqual(m.executionLogs(db), []);
  assert.deepEqual(m.workflows(db), []);
});

test("settings mask never reveals any part of a secret", async () => {
  const { mask } = await import("../lib/settings");
  assert.equal(mask(""), "");
  assert.equal(mask("sk-ant-oat01-SECRETVALUE1234"), "Set");
});
