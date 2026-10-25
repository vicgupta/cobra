// Sessions: a 32-byte random token goes in the cookie; only its sha256 is stored.
// Each session also has a random public_id, used to list and end sessions.
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "../db";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // "remember me"
export const SESSION_SHORT_TTL_MS = 12 * 60 * 60 * 1000; // not remembered
export const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
export const SESSION_COOKIE = "cobra_session";
const UA_MAX = 200;

export type SessionUser = {
  id: number; email: string; name: string; role: "admin" | "team_lead" | "member";
  tenantId: number; tenantName: string; tenantSlug: string;
  sessionId: string;
};

export type SessionInfo = {
  id: string; remember: boolean; createdAt: number; lastSeenAt: number; expiresAt: number;
  userAgent: string; ip: string; current: boolean;
};

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(
  db: DB, userId: number, now = Date.now(),
  opts: { remember?: boolean; userAgent?: string | null; ip?: string | null } = {},
): { token: string; expiresAt: number; remember: boolean; sessionId: string } {
  const remember = opts.remember ?? true;
  const token = randomBytes(32).toString("base64url");
  const sessionId = randomBytes(16).toString("hex");
  const expiresAt = now + (remember ? SESSION_TTL_MS : SESSION_SHORT_TTL_MS);
  db.prepare(`INSERT INTO sessions (id, public_id, user_id, expires_at, created_at, last_seen_at, remember, user_agent, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hashToken(token), sessionId, userId, expiresAt, now, now, remember ? 1 : 0, (opts.userAgent ?? "").slice(0, UA_MAX), (opts.ip ?? "").slice(0, 64));
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return { token, expiresAt, remember, sessionId };
}

export function getSessionUser(db: DB, token: string | undefined, now = Date.now()): SessionUser | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, t.id AS tenantId, t.name AS tenantName, t.slug AS tenantSlug,
      s.public_id AS sessionId, s.expires_at AS expiresAt, s.last_seen_at AS lastSeenAt
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id WHERE s.id = ?`).get(hashToken(token)) as
    (SessionUser & { expiresAt: number; lastSeenAt: number | null }) | undefined;
  if (!row) return null;
  if (row.expiresAt <= now) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
    return null;
  }
  // Throttled so page loads don't write on every request.
  if (row.lastSeenAt === null || now - row.lastSeenAt >= LAST_SEEN_INTERVAL_MS)
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, hashToken(token));
  const { expiresAt: _e, lastSeenAt: _l, ...user } = row;
  void _e; void _l;
  return user;
}

export function deleteSession(db: DB, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
}

/** The user's own active sessions, newest activity first. */
export function listSessions(db: DB, userId: number, currentSessionId: string | null, now = Date.now()): SessionInfo[] {
  const rows = db.prepare(`SELECT public_id, remember, created_at, last_seen_at, expires_at, user_agent, ip
    FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY coalesce(last_seen_at, created_at) DESC`).all(userId, now) as Array<{
      public_id: string; remember: number; created_at: number; last_seen_at: number | null; expires_at: number; user_agent: string; ip: string }>;
  return rows.map((r) => ({
    id: r.public_id, remember: !!r.remember, createdAt: r.created_at, lastSeenAt: r.last_seen_at ?? r.created_at,
    expiresAt: r.expires_at, userAgent: r.user_agent, ip: r.ip, current: r.public_id === currentSessionId,
  }));
}

/** Ends one of the user's sessions. False when no such session belongs to the user. */
export function endSession(db: DB, userId: number, sessionId: string): boolean {
  return db.prepare("DELETE FROM sessions WHERE public_id = ? AND user_id = ?").run(sessionId, userId).changes > 0;
}

/** Ends all the user's sessions except the current one; returns how many ended. */
export function endOtherSessions(db: DB, userId: number, currentSessionId: string): number {
  return Number(db.prepare("DELETE FROM sessions WHERE user_id = ? AND public_id IS NOT ?").run(userId, currentSessionId).changes);
}

/**
 * Settings and test runs still use the single shared /etc/cobra/cobra.env, so
 * only admins of the `default` tenant may use them.
 */
export function canUseSharedConfig(user: Pick<SessionUser, "role" | "tenantSlug"> | null): boolean {
  return !!user && user.role === "admin" && user.tenantSlug === "default";
}
