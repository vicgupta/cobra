import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { canUseSharedConfig, createSession, deleteSession, getSessionUser, SESSION_TTL_MS } from "../lib/auth/sessions";
import { authenticate, seedAdmin, signUp } from "../lib/auth/users";
import { clearFailures, isLimited, recordFailure } from "../lib/auth/rate-limit";

test("password hashing: salted, verifies, rejects wrong", () => {
  const a = hashPassword("correct horse"), b = hashPassword("correct horse");
  assert.notEqual(a, b);
  assert.ok(verifyPassword("correct horse", a));
  assert.ok(!verifyPassword("wrong", a));
  assert.ok(!verifyPassword("x", "garbage"));
});

test("sessions: create, lookup, expiry, logout; token stored hashed", () => {
  const db = openDb(":memory:");
  seedAdmin(db, { username: "vic", email: "VicGupta@gmail.com", name: "Vic", password: "pw-123456" });
  const id = authenticate(db, "vic", "pw-123456")!;
  assert.equal(authenticate(db, "vicgupta@gmail.com", "pw-123456"), id);
  assert.equal(authenticate(db, "vic", "nope"), null);
  const now = 1_000_000;
  const { token, expiresAt } = createSession(db, id, now);
  assert.equal(expiresAt, now + SESSION_TTL_MS);
  assert.equal((db.prepare("SELECT count(*) c FROM sessions WHERE id = ?").get(token) as { c: number }).c, 0);
  assert.equal(getSessionUser(db, token, now + 1)?.tenantSlug, "default");
  assert.equal(getSessionUser(db, token, expiresAt), null);
  const s2 = createSession(db, id, now);
  deleteSession(db, s2.token);
  assert.equal(getSessionUser(db, s2.token, now), null);
  assert.equal(getSessionUser(db, "bogus", now), null);
});

test("default-tenant guard: only default admins use shared config", () => {
  const db = openDb(":memory:");
  seedAdmin(db, { username: "vic", email: "v@x.io", name: "Vic", password: "pw-123456" });
  const other = signUp(db, { name: "T", email: "t@example.com", password: "pw-1234567890", team: "Default" });
  const vic = getSessionUser(db, createSession(db, authenticate(db, "vic", "pw-123456")!).token)!;
  const t = getSessionUser(db, createSession(db, other).token)!;
  assert.equal(t.tenantSlug, "default-team");
  assert.equal(t.role, "admin");
  assert.ok(canUseSharedConfig(vic));
  assert.ok(!canUseSharedConfig(t));
  assert.ok(!canUseSharedConfig({ role: "member", tenantSlug: "default" }));
  assert.ok(!canUseSharedConfig(null));
});

test("rate limit after 10 failures", () => {
  for (let i = 0; i < 10; i++) recordFailure("k", 0);
  assert.ok(isLimited("k", 1));
  assert.ok(!isLimited("k", 15 * 60 * 1000 + 1));
  clearFailures("k");
});
