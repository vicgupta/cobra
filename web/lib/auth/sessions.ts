// Sessions: a 32-byte random token goes in the cookie; only its sha256 is stored.
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "../db";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "cobra_session";

export type SessionUser = {
  id: number; email: string; username: string | null; name: string; role: "admin" | "member";
  tenantId: number; tenantName: string; tenantSlug: string;
};

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(db: DB, userId: number, now = Date.now()): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hashToken(token), userId, expiresAt, now);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return { token, expiresAt };
}

export function getSessionUser(db: DB, token: string | undefined, now = Date.now()): SessionUser | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.username, u.name, u.role, t.id AS tenantId, t.name AS tenantName, t.slug AS tenantSlug, s.expires_at AS expiresAt
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id WHERE s.id = ?`).get(hashToken(token)) as
    (SessionUser & { expiresAt: number }) | undefined;
  if (!row) return null;
  if (row.expiresAt <= now) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
    return null;
  }
  const { expiresAt: _e, ...user } = row;
  void _e;
  return user;
}

export function deleteSession(db: DB, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
}

/**
 * Settings and test runs still use the single shared /etc/cobra/cobra.env, so
 * only admins of the `default` tenant may use them.
 */
export function canUseSharedConfig(user: Pick<SessionUser, "role" | "tenantSlug"> | null): boolean {
  return !!user && user.role === "admin" && user.tenantSlug === "default";
}
