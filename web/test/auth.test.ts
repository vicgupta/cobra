import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb } from "../lib/db";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { canUseSharedConfig, createSession, deleteSession, getSessionUser, SESSION_TTL_MS } from "../lib/auth/sessions";
import { authenticate, createUser, resetPassword } from "../lib/auth/users";
import { createResetToken, GENERIC_RESET_MESSAGE, hashResetToken, requestReset, RESET_TTL_MS, resetTokenState, resetWithToken, throttleReset } from "../lib/auth/password-reset";
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

const count = (db: DatabaseSync, sql: string, ...a: Array<string | number>) => (db.prepare(sql).get(...a) as { c: number }).c;

test("migration 4 adds password_resets on an existing v3 database", () => {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "v@x.io", tenant: "default", role: "admin", password: PW });
  const { token } = createSession(db, id);
  // Roll the schema back to v3 (pre-reset) with data in place, then migrate.
  db.exec("DROP TABLE password_resets; PRAGMA user_version = 3;");
  migrate(db);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
  const cols = (db.prepare("PRAGMA table_info(password_resets)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["user_id", "token_hash", "expires_at", "used_at"]) assert.ok(cols.includes(c), c);
  assert.equal(authenticate(db, "v@x.io", PW), id);
  assert.equal(getSessionUser(db, token)?.id, id);
  migrate(db); // no-op when current
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
});

test("reset tokens: random, stored only as sha256, expire after 30 minutes", () => {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "d@x.io", tenant: "default", role: "member", password: PW });
  const now = 5_000_000;
  const a = createResetToken(db, " D@x.io ", now)!, b = createResetToken(db, "d@x.io", now)!;
  assert.equal(a.userId, id);
  assert.notEqual(a.token, b.token);
  assert.ok(Buffer.from(a.token, "base64url").length >= 32);
  assert.equal(count(db, "SELECT count(*) c FROM password_resets WHERE token_hash = ?", a.token), 0);
  const row = db.prepare("SELECT expires_at, used_at FROM password_resets WHERE token_hash = ?").get(hashResetToken(a.token)) as { expires_at: number; used_at: null };
  assert.equal(row.expires_at, now + RESET_TTL_MS);
  assert.equal(row.used_at, null);
  assert.equal(resetTokenState(db, a.token, now + RESET_TTL_MS - 1), "valid");
  assert.equal(resetTokenState(db, a.token, now + RESET_TTL_MS), "expired");
  assert.equal(resetTokenState(db, "nope", now), "unknown");
  const r = resetWithToken(db, a.token, "new-password-123", now + RESET_TTL_MS);
  assert.ok(!r.ok && /expired/.test(r.error));
  assert.equal(authenticate(db, "d@x.io", PW), id);
});

test("reset: single use, invalidates other tokens, ends all sessions, min length", () => {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "d@x.io", tenant: "default", role: "member", password: PW });
  const other = createUser(db, { email: "o@x.io", tenant: "default", role: "member", password: PW });
  const now = Date.now();
  const s1 = createSession(db, id, now), s2 = createSession(db, id, now), so = createSession(db, other, now);
  const t1 = createResetToken(db, "d@x.io", now)!, t2 = createResetToken(db, "d@x.io", now)!;
  const short = resetWithToken(db, t1.token, "short", now);
  assert.ok(!short.ok && /10 characters/.test(short.error));
  assert.equal(resetTokenState(db, t1.token, now), "valid");
  assert.deepEqual(resetWithToken(db, t1.token, "brand-new-pass-1", now), { ok: true, userId: id });
  assert.equal(authenticate(db, "d@x.io", PW), null);
  assert.equal(authenticate(db, "d@x.io", "brand-new-pass-1"), id);
  assert.equal(getSessionUser(db, s1.token, now), null);
  assert.equal(getSessionUser(db, s2.token, now), null);
  assert.equal(getSessionUser(db, so.token, now)?.id, other);
  assert.equal(resetTokenState(db, t1.token, now), "used");
  assert.equal(resetTokenState(db, t2.token, now), "used");
  const again = resetWithToken(db, t1.token, "another-pass-12", now);
  assert.ok(!again.ok && /already been used/.test(again.error));
  assert.ok(!resetWithToken(db, t2.token, "another-pass-12", now).ok);
  assert.equal(authenticate(db, "d@x.io", "brand-new-pass-1"), id);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  assert.equal(count(db, "SELECT count(*) c FROM password_resets"), 0);
});

test("reset request: generic message, nothing sent or stored for unknown email; throttled per email", async () => {
  const db = openDb(":memory:");
  createUser(db, { email: "known@x.io", tenant: "default", role: "member", password: PW });
  const sent: string[] = [];
  const send = async (to: string, _s: string, body: string) => { sent.push(to + " " + body); };
  const now = 9_000_000;
  assert.equal(requestReset(db, "unknown@x.io", send, now), GENERIC_RESET_MESSAGE);
  assert.equal(sent.length, 0);
  assert.equal(count(db, "SELECT count(*) c FROM password_resets"), 0);
  assert.equal(requestReset(db, "Known@x.io", send, now), GENERIC_RESET_MESSAGE);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^known@x\.io [\s\S]*https:\/\/nova\.kantsy\.com\/reset-password\?token=[A-Za-z0-9_-]{43}\n/);
  requestReset(db, "known@x.io", send, now);
  requestReset(db, "known@x.io", send, now);
  assert.equal(requestReset(db, "known@x.io", send, now), GENERIC_RESET_MESSAGE);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 3);
  assert.equal(count(db, "SELECT count(*) c FROM password_resets"), 3);
  for (let i = 0; i < 10; i++) assert.equal(throttleReset("ip:t", 10, now), false);
  assert.equal(throttleReset("ip:t", 10, now), true);
  assert.equal(throttleReset("ip:t", 10, now + 15 * 60 * 1000), false);
});
