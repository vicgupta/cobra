import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb } from "../lib/db";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { canUseSharedConfig, createSession, deleteSession, getSessionUser, SESSION_TTL_MS } from "../lib/auth/sessions";
import { authenticate, createUser, resetPassword } from "../lib/auth/users";
import { clearFailures, isLimited, recordFailure } from "../lib/auth/rate-limit";

const PW = "pw-1234567890";

test("password hashing: salted, verifies, rejects wrong", () => {
  const a = hashPassword("correct horse"), b = hashPassword("correct horse");
  assert.notEqual(a, b);
  assert.ok(verifyPassword("correct horse", a));
  assert.ok(!verifyPassword("wrong", a));
  assert.ok(!verifyPassword("x", "garbage"));
});

test("email is the login ID; sessions create/expire/logout; token stored hashed", () => {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "VicGupta@gmail.com", tenant: "default", role: "admin", password: PW });
  assert.equal(authenticate(db, "vicgupta@gmail.com", PW), id);
  assert.equal(authenticate(db, " VICGUPTA@gmail.com ", PW), id);
  assert.equal(authenticate(db, "vic", PW), null);
  assert.equal(authenticate(db, "vicgupta@gmail.com", "nope"), null);
  assert.throws(() => createUser(db, { email: "vicgupta@gmail.com", tenant: "default", role: "member", password: PW }));
  const now = 1_000_000;
  const { token, expiresAt } = createSession(db, id, now);
  assert.equal(expiresAt, now + SESSION_TTL_MS);
  assert.equal((db.prepare("SELECT count(*) c FROM sessions WHERE id = ?").get(token) as { c: number }).c, 0);
  assert.equal(getSessionUser(db, token, now + 1)?.tenantSlug, "default");
  assert.equal(getSessionUser(db, token, expiresAt), null);
  const s2 = createSession(db, id, now);
  deleteSession(db, s2.token);
  assert.equal(getSessionUser(db, s2.token, now), null);
  const s3 = createSession(db, id, now);
  resetPassword(db, "vicgupta@gmail.com", "new-password-123");
  assert.equal(getSessionUser(db, s3.token, now), null);
  assert.equal(authenticate(db, "vicgupta@gmail.com", "new-password-123"), id);
});

test("default-tenant guard: only default admins use shared config", () => {
  const db = openDb(":memory:");
  const vic = createUser(db, { email: "v@x.io", tenant: "default", role: "admin", password: PW });
  const mem = createUser(db, { email: "m@x.io", tenant: "default", role: "member", password: PW });
  assert.throws(() => createUser(db, { email: "o@x.io", tenant: "acme", role: "admin", password: PW }));
  const other = createUser(db, { email: "o@x.io", tenant: "acme", tenantName: "Acme", role: "admin", password: PW });
  const u = (id: number) => getSessionUser(db, createSession(db, id).token)!;
  assert.ok(canUseSharedConfig(u(vic)));
  assert.ok(!canUseSharedConfig(u(mem)));
  assert.ok(!canUseSharedConfig(u(other)));
  assert.ok(!canUseSharedConfig(null));
});

test("migration 3 drops username, keeping ids, sessions and email login", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, email TEXT NOT NULL UNIQUE CHECK (email = lower(email)), username TEXT UNIQUE, name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','member')), created_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, issue INTEGER NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', simulated INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL);
    PRAGMA user_version = 2;`);
  db.prepare("INSERT INTO tenants VALUES (1, 'Vic', 'default', 0)").run();
  db.prepare("INSERT INTO users VALUES (7, 1, 'vicgupta@gmail.com', 'vic', 'Vic', ?, 'admin', 0)").run(hashPassword(PW));
  const { token } = createSession(db, 7, Date.now());
  migrate(db);
  const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!cols.includes("username"));
  assert.equal(authenticate(db, "vicgupta@gmail.com", PW), 7);
  assert.equal(authenticate(db, "vic", PW), null);
  assert.equal(getSessionUser(db, token)?.id, 7);
  db.prepare("DELETE FROM tenants WHERE id = 1").run();
  assert.equal((db.prepare("SELECT count(*) c FROM sessions").get() as { c: number }).c, 0);
});

test("login rate limit after 10 failures", () => {
  for (let i = 0; i < 10; i++) recordFailure("k", 0);
  assert.ok(isLimited("k", 1));
  assert.ok(!isLimited("k", 15 * 60 * 1000 + 1));
  clearFailures("k");
});
