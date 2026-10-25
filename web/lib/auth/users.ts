import type { DB } from "../db";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./password";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 10;
const norm = (email: string) => email.trim().toLowerCase();

/** Returns the user id when the email and password match. Email is the only login ID. */
export function authenticate(db: DB, email: string, password: string): number | null {
  const row = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(norm(email)) as
    { id: number; password_hash: string } | undefined;
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return row && ok ? row.id : null;
}

/**
 * Admin-only account creation (CLI). The tenant must exist, except `default`
 * ('Vic') and any tenant given with tenantName, which are created on demand.
 */
export function createUser(
  db: DB,
  p: { email: string; password: string; tenant: string; role: "admin" | "team_lead" | "member"; name?: string; tenantName?: string },
  now = Date.now(),
): number {
  const email = norm(p.email);
  if (!EMAIL_RE.test(email)) throw new Error("Invalid email");
  if (p.password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (!["admin", "team_lead", "member"].includes(p.role)) throw new Error("role must be admin, team_lead or member");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new Error("A user with that email already exists");
  let t = db.prepare("SELECT id FROM tenants WHERE slug = ?").get(p.tenant) as { id: number } | undefined;
  if (!t) {
    const name = p.tenant === "default" ? "Vic" : p.tenantName;
    if (!name) throw new Error(`Tenant '${p.tenant}' does not exist; pass --tenant-name to create it`);
    t = { id: Number(db.prepare("INSERT INTO tenants (name, slug, created_at) VALUES (?, ?, ?)").run(name, p.tenant, now).lastInsertRowid) };
  }
  return Number(db.prepare("INSERT INTO users (tenant_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(t.id, email, p.name ?? "", hashPassword(p.password), p.role, now).lastInsertRowid);
}

/** Sets a new password and signs the user out everywhere. */
export function resetPassword(db: DB, email: string, password: string): void {
  if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  const r = db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hashPassword(password), norm(email));
  if (!r.changes) throw new Error("No user with that email");
  db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(norm(email));
}
