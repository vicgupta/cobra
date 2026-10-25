import type { DB } from "../db";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./password";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "team";
}

/** Returns the user id when the login (email or username) and password match. */
export function authenticate(db: DB, login: string, password: string): number | null {
  const l = login.trim().toLowerCase();
  const row = db.prepare("SELECT id, password_hash FROM users WHERE email = ? OR lower(username) = ?").get(l, l) as
    { id: number; password_hash: string } | undefined;
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return row && ok ? row.id : null;
}

/** Creates a new tenant with this user as its admin. Never uses the reserved `default` slug. */
export function signUp(db: DB, p: { name: string; email: string; password: string; team: string }, now = Date.now()): number {
  const email = p.email.trim().toLowerCase();
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new Error("An account with that email already exists");
  const base = slugify(p.team) === "default" ? "default-team" : slugify(p.team);
  let slug = base;
  for (let i = 2; db.prepare("SELECT 1 FROM tenants WHERE slug = ?").get(slug); i++) slug = `${base}-${i}`;
  db.exec("BEGIN");
  try {
    const t = db.prepare("INSERT INTO tenants (name, slug, created_at) VALUES (?, ?, ?)").run(p.team.trim(), slug, now);
    const u = db.prepare("INSERT INTO users (tenant_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)")
      .run(Number(t.lastInsertRowid), email, p.name.trim(), hashPassword(p.password), now);
    db.exec("COMMIT");
    return Number(u.lastInsertRowid);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Creates or updates the default tenant ('Vic', slug default) and its admin user. */
export function seedAdmin(db: DB, p: { username: string; email: string; name: string; password: string }, now = Date.now()): "created" | "updated" {
  db.prepare("INSERT OR IGNORE INTO tenants (name, slug, created_at) VALUES ('Vic', 'default', ?)").run(now);
  const t = db.prepare("SELECT id FROM tenants WHERE slug = 'default'").get() as { id: number };
  const email = p.email.toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ? OR username = ?").get(email, p.username) as { id: number } | undefined;
  const hash = hashPassword(p.password);
  if (existing) {
    db.prepare("UPDATE users SET tenant_id = ?, email = ?, username = ?, name = ?, password_hash = ?, role = 'admin' WHERE id = ?")
      .run(t.id, email, p.username, p.name, hash, existing.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
    return "updated";
  }
  db.prepare("INSERT INTO users (tenant_id, email, username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)")
    .run(t.id, email, p.username, p.name, hash, now);
  return "created";
}
