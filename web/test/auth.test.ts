import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb } from "../lib/db";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { canUseSharedConfig, createSession, deleteSession, endOtherSessions, endSession, getSessionUser, LAST_SEEN_INTERVAL_MS, listSessions, SESSION_SHORT_TTL_MS, SESSION_TTL_MS } from "../lib/auth/sessions";
import { authenticate, createUser, resetPassword } from "../lib/auth/users";
import { createResetToken, GENERIC_RESET_MESSAGE, hashResetToken, requestReset, RESET_TTL_MS, resetTokenState, resetWithToken } from "../lib/auth/password-reset";
import { cleanupRateLimits, consume, emailKey, LIMITS, peek } from "../lib/auth/rate-limit";
import { loginBlocked, recordLoginFailure, recordLoginSuccess } from "../lib/auth/login-limit";
import { clientIp } from "../lib/client-ip";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PW = "pw-1234567890";
const count = (db: DatabaseSync, sql: string, ...a: Array<string | number>) => (db.prepare(sql).get(...a) as { c: number }).c;

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
  assert.ok(!canUseSharedConfig(u(mem)), "members can't start runs/test runs (shared config) or see agent status");
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
  // A pre-migration-5 session row (no metadata columns yet) must stay valid.
  const token = "legacy-session-token";
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 7, ?, ?)").run(createHash("sha256").update(token).digest("hex"), Date.now() + 60_000, Date.now());
  migrate(db);
  const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!cols.includes("username"));
  assert.equal(authenticate(db, "vicgupta@gmail.com", PW), 7);
  assert.equal(authenticate(db, "vic", PW), null);
  assert.equal(getSessionUser(db, token)?.id, 7);
  db.prepare("DELETE FROM tenants WHERE id = 1").run();
  assert.equal((db.prepare("SELECT count(*) c FROM sessions").get() as { c: number }).c, 0);
});

const M15 = 15 * 60 * 1000;

test("login: per-account lockout after 10 failures, Retry-After, success clears account only", () => {
  const db = openDb(":memory:");
  const now = 1_000_000;
  for (let i = 0; i < 9; i++) recordLoginFailure(db, `10.0.0.${i}`, "A@x.io", now);
  assert.equal(loginBlocked(db, "10.9.9.9", "a@x.io", now), null);
  recordLoginFailure(db, "10.0.0.9", "a@x.io", now);
  const b = loginBlocked(db, "10.9.9.9", " a@X.io ", now + 60_000)!;
  assert.ok(b.limited);
  assert.equal(b.retryAfterSec, (M15 - 60_000) / 1000);
  assert.equal(loginBlocked(db, "10.9.9.9", "other@x.io", now), null);
  // raw email never stored
  assert.equal(count(db, "SELECT count(*) c FROM rate_limits WHERE key LIKE '%@%'"), 0);
  recordLoginSuccess(db, "a@x.io");
  assert.equal(loginBlocked(db, "10.9.9.9", "a@x.io", now), null);
  // per-IP: 10 failures across accounts lock the IP; a success does not clear it
  for (let i = 0; i < 10; i++) recordLoginFailure(db, "6.6.6.6", `u${i}@x.io`, now);
  recordLoginSuccess(db, "u0@x.io");
  assert.ok(loginBlocked(db, "6.6.6.6", "new@x.io", now));
});

test("rate limits: window expiry and cleanup of expired rows", () => {
  const db = openDb(":memory:");
  const now = 5_000_000;
  for (let i = 0; i < 10; i++) assert.equal(consume(db, LIMITS.forgotIp, "1.1.1.1", now).limited, false);
  assert.equal(consume(db, LIMITS.forgotIp, "1.1.1.1", now).limited, true);
  assert.equal(peek(db, LIMITS.forgotIp, "1.1.1.1", now).count, 10);
  assert.equal(consume(db, LIMITS.forgotIp, "1.1.1.1", now + M15).limited, false);
  assert.equal(peek(db, LIMITS.forgotIp, "1.1.1.1", now + M15).count, 1);
  consume(db, LIMITS.resetIp, "2.2.2.2", now);
  assert.equal(cleanupRateLimits(db, now + 2 * M15, true), 2);
  assert.equal(count(db, "SELECT count(*) c FROM rate_limits"), 0);
});

test("rate limits persist across a DB reopen (simulated restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-rl-"));
  try {
    const file = join(dir, "t.db"), now = Date.now();
    let db = openDb(file);
    for (let i = 0; i < 10; i++) recordLoginFailure(db, "3.3.3.3", "r@x.io", now);
    for (let i = 0; i < 20; i++) consume(db, LIMITS.resetIp, "4.4.4.4", now);
    db.close();
    db = openDb(file);
    assert.ok(loginBlocked(db, "9.9.9.9", "r@x.io", now + 1000));
    assert.ok(loginBlocked(db, "3.3.3.3", "x@x.io", now + 1000));
    assert.equal(consume(db, LIMITS.resetIp, "4.4.4.4", now + 1000).limited, true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client IP: trusts nginx X-Real-IP / last X-Forwarded-For hop, not client-supplied entries", () => {
  const r = (h: Record<string, string>) => clientIp(new Request("http://x/", { headers: h }));
  assert.equal(r({ "x-real-ip": "5.5.5.5", "x-forwarded-for": "1.2.3.4, 5.5.5.5" }), "5.5.5.5");
  assert.equal(r({ "x-forwarded-for": "1.2.3.4, 5.5.5.5" }), "5.5.5.5");
  assert.equal(r({}), "local");
});


test("migration 4 adds password_resets on an existing v3 database", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, 3);
  db.prepare("INSERT INTO tenants VALUES (1, 'Vic', 'default', 0)").run();
  db.prepare("INSERT INTO users (id, tenant_id, email, password_hash, role, created_at) VALUES (3, 1, 'v@x.io', ?, 'admin', 0)").run(hashPassword(PW));
  const id = 3;
  migrate(db, 4);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
  migrate(db);
  const { token } = createSession(db, id);
  const cols = (db.prepare("PRAGMA table_info(password_resets)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["user_id", "token_hash", "expires_at", "used_at"]) assert.ok(cols.includes(c), c);
  assert.equal(authenticate(db, "v@x.io", PW), id);
  assert.equal(getSessionUser(db, token)?.id, id);
  migrate(db); // no-op when current
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 36);
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
  // per-email limit is silent: 4th request same generic message, no email, no token
  assert.equal(peek(db, LIMITS.forgotEmail, emailKey("known@x.io"), now).limited, true);
  assert.equal(requestReset(db, "KNOWN@x.io", send, now + 1000), GENERIC_RESET_MESSAGE);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 3);
  assert.equal(count(db, "SELECT count(*) c FROM password_resets"), 3);
  // and it expires with the window
  requestReset(db, "known@x.io", send, now + 15 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 4);
});

test("migration 6: rate_limits table created from v5 with data intact", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, 5);
  db.prepare("INSERT INTO tenants VALUES (1, 'Vic', 'default', 0)").run();
  migrate(db);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 36);
  assert.equal(count(db, "SELECT count(*) c FROM tenants"), 1);
  const cols = (db.prepare("PRAGMA table_info(rate_limits)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols, ["bucket", "key", "count", "window_start", "expires_at"]);
  assert.equal(consume(db, LIMITS.loginIp, "1.1.1.1").count, 1);
});

test("migration 5: existing sessions stay valid (remembered), get a public id and metadata columns", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, 4);
  db.prepare("INSERT INTO tenants VALUES (1, 'Vic', 'default', 0)").run();
  db.prepare("INSERT INTO users (id, tenant_id, email, password_hash, role, created_at) VALUES (5, 1, 'v@x.io', ?, 'admin', 0)").run(hashPassword(PW));
  const token = "v4-session-token", t0 = Date.now() - 1000;
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 5, ?, ?)").run(createHash("sha256").update(token).digest("hex"), Date.now() + SESSION_TTL_MS, t0);
  migrate(db);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 36);
  const u = getSessionUser(db, token)!;
  assert.equal(u.id, 5);
  assert.match(u.sessionId, /^[0-9a-f]{32}$/);
  const [s] = listSessions(db, 5, u.sessionId);
  assert.equal(s.remember, true);
  assert.ok(s.current);
  assert.equal(s.createdAt, t0);
  assert.equal(authenticate(db, "v@x.io", PW), 5);
});

test("remember me: 30-day vs 12-hour server-side expiry; metadata stored; last_seen throttled", () => {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "d@x.io", tenant: "default", role: "member", password: PW });
  const now = 10_000_000;
  const long = createSession(db, id, now, { remember: true, userAgent: "UA-" + "x".repeat(500), ip: "1.2.3.4" });
  const short = createSession(db, id, now, { remember: false });
  assert.equal(long.expiresAt, now + SESSION_TTL_MS);
  assert.equal(short.expiresAt, now + SESSION_SHORT_TTL_MS);
  assert.equal(SESSION_SHORT_TTL_MS, 12 * 60 * 60 * 1000);
  assert.ok(getSessionUser(db, short.token, now + SESSION_SHORT_TTL_MS - 1));
  assert.equal(getSessionUser(db, short.token, now + SESSION_SHORT_TTL_MS), null);
  assert.ok(getSessionUser(db, long.token, now + SESSION_SHORT_TTL_MS));
  const l = listSessions(db, id, long.sessionId, now + SESSION_SHORT_TTL_MS).find((s) => s.id === long.sessionId)!;
  assert.equal(l.remember, true);
  assert.equal(l.ip, "1.2.3.4");
  assert.equal(l.userAgent.length, 200);
  assert.equal(l.createdAt, now);
  assert.equal(l.lastSeenAt, now + SESSION_SHORT_TTL_MS);
  getSessionUser(db, long.token, now + SESSION_SHORT_TTL_MS + LAST_SEEN_INTERVAL_MS - 1);
  assert.equal(listSessions(db, id, null, now + SESSION_SHORT_TTL_MS)[0].lastSeenAt, now + SESSION_SHORT_TTL_MS);
  getSessionUser(db, long.token, now + SESSION_SHORT_TTL_MS + LAST_SEEN_INTERVAL_MS);
  assert.equal(listSessions(db, id, null, now + SESSION_SHORT_TTL_MS)[0].lastSeenAt, now + SESSION_SHORT_TTL_MS + LAST_SEEN_INTERVAL_MS);
});

test("sessions page: only own sessions; end one; end all others keeps current; cross-user rejected", () => {
  const db = openDb(":memory:");
  const a = createUser(db, { email: "a@x.io", tenant: "default", role: "member", password: PW });
  const b = createUser(db, { email: "b@x.io", tenant: "default", role: "admin", password: PW });
  const now = Date.now();
  const a1 = createSession(db, a, now), a2 = createSession(db, a, now), a3 = createSession(db, a, now, { remember: false });
  const b1 = createSession(db, b, now), b2 = createSession(db, b, now);
  const listA = listSessions(db, a, a1.sessionId, now);
  assert.deepEqual(listA.map((s) => s.id).sort(), [a1.sessionId, a2.sessionId, a3.sessionId].sort());
  assert.deepEqual(listA.filter((s) => s.current).map((s) => s.id), [a1.sessionId]);
  assert.ok(!JSON.stringify(listA).includes(a1.token));
  // Cross-user: A cannot end B's session.
  assert.equal(endSession(db, a, b1.sessionId), false);
  assert.ok(getSessionUser(db, b1.token, now));
  // End one.
  assert.equal(endSession(db, a, a2.sessionId), true);
  assert.equal(getSessionUser(db, a2.token, now), null);
  assert.equal(endSession(db, a, a2.sessionId), false);
  // End all others keeps current, and leaves other users alone.
  assert.equal(endOtherSessions(db, a, a1.sessionId), 1);
  assert.ok(getSessionUser(db, a1.token, now));
  assert.equal(getSessionUser(db, a3.token, now), null);
  assert.ok(getSessionUser(db, b1.token, now));
  assert.ok(getSessionUser(db, b2.token, now));
  assert.deepEqual(listSessions(db, a, a1.sessionId, now).map((s) => s.id), [a1.sessionId]);
  assert.equal(listSessions(db, b, null, now).length, 2);
});
