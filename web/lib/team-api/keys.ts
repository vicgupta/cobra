// Team API keys (migration 36). Each key is bound to exactly one team and one repo of that team.
// Generated only by a team lead (or the team's designated lead) of that team; system admins get no bypass.
// The plaintext is returned once at creation; only its sha256 hash and a short display prefix are stored.
// Keys are never logged.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "../db";

export type KeyUser = { id: number; email: string; role: string; tenantId: number };
export class KeyError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export const KEY_PREFIX = "cbk_";
export const KEY_RE = /^cbk_[A-Za-z0-9_-]{43}$/;
export const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");

export type ApiKey = { id: number; tenantId: number; repoId: number; repo: string; name: string; prefix: string; createdBy: string | null; createdAt: number; lastUsedAt: number | null; revokedAt: number | null };
type Row = { id: number; tenant_id: number; repo_id: number; repo: string; name: string; prefix: string; created_by_email: string | null; created_at: number; last_used_at: number | null; revoked_at: number | null };
const from = (r: Row): ApiKey => ({ id: r.id, tenantId: r.tenant_id, repoId: r.repo_id, repo: r.repo, name: r.name, prefix: r.prefix, createdBy: r.created_by_email, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at });
const SELECT = "SELECT k.id, k.tenant_id, k.repo_id, r.repo, k.name, k.prefix, u.email AS created_by_email, k.created_at, k.last_used_at, k.revoked_at FROM api_keys k JOIN team_repos r ON r.id = k.repo_id LEFT JOIN users u ON u.id = k.created_by";

/** Team lead of this team, or its designated lead. Role 'admin' alone is NOT enough (team confinement). */
export function canManageKeys(db: DB, u: Pick<KeyUser, "id" | "role" | "tenantId">, tenantId = u.tenantId): boolean {
  if (u.tenantId !== tenantId) return false;
  const row = db.prepare("SELECT u.role, u.tenant_id AS t, (SELECT designated_lead_user_id FROM tenants WHERE id = ?) AS d FROM users u WHERE u.id = ?").get(tenantId, u.id) as { role: string; t: number; d: number | null } | undefined;
  if (!row || row.t !== tenantId) return false;
  return row.role === "team_lead" || row.d === u.id;
}

export function listKeys(db: DB, tenantId: number): ApiKey[] {
  return (db.prepare(`${SELECT} WHERE k.tenant_id = ? ORDER BY k.revoked_at IS NOT NULL, k.id DESC`).all(tenantId) as Row[]).map(from);
}

export function createKey(db: DB, u: KeyUser, b: { repo?: unknown; repoId?: unknown; name?: unknown } | null, now = Date.now()): { key: ApiKey; plaintext: string } {
  if (!canManageKeys(db, u)) throw new KeyError(403, "only team leads and the designated lead of this team can create API keys");
  const name = typeof b?.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80) throw new KeyError(400, "name is required (at most 80 characters)");
  const repo = (typeof b?.repoId === "number" || typeof b?.repoId === "string"
    ? db.prepare("SELECT id FROM team_repos WHERE id = ? AND tenant_id = ?").get(Number(b.repoId), u.tenantId)
    : typeof b?.repo === "string" ? db.prepare("SELECT id FROM team_repos WHERE repo = ? AND tenant_id = ?").get(b.repo.trim(), u.tenantId) : undefined) as { id: number } | undefined;
  if (!repo) throw new KeyError(404, "repo not found in your team");
  const plaintext = KEY_PREFIX + randomBytes(32).toString("base64url");
  const r = db.prepare("INSERT INTO api_keys (tenant_id, repo_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, repo.id, name, plaintext.slice(0, 12), hashKey(plaintext), u.id, now);
  const id = Number(r.lastInsertRowid);
  apiAudit(db, { tenantId: u.tenantId, repoId: repo.id, keyId: id, actor: u.email, action: "key_create", target: `key:${id}`, status: 201, at: now });
  return { key: from(db.prepare(`${SELECT} WHERE k.id = ?`).get(id) as Row), plaintext };
}

export function revokeKey(db: DB, u: KeyUser, id: number, now = Date.now()): ApiKey {
  const k = db.prepare("SELECT tenant_id, repo_id, revoked_at FROM api_keys WHERE id = ?").get(id) as { tenant_id: number; repo_id: number; revoked_at: number | null } | undefined;
  if (!k || k.tenant_id !== u.tenantId) throw new KeyError(404, "key not found");
  if (!canManageKeys(db, u)) throw new KeyError(403, "only team leads and the designated lead of this team can revoke API keys");
  if (k.revoked_at === null) {
    db.prepare("UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?").run(now, u.id, id);
    apiAudit(db, { tenantId: u.tenantId, repoId: k.repo_id, keyId: id, actor: u.email, action: "key_revoke", target: `key:${id}`, status: 200, at: now });
  }
  return from(db.prepare(`${SELECT} WHERE k.id = ?`).get(id) as Row);
}

export type KeyPrincipal = { keyId: number; tenantId: number; repoId: number; repo: string; prefix: string; userId: number; email: string };

/** Resolves a bearer key. null = missing, malformed, unknown, revoked, or its creator is no longer a lead of that team. */
export function resolveKey(db: DB, raw: string | null | undefined, now = Date.now()): KeyPrincipal | null {
  if (!raw || !KEY_RE.test(raw)) return null;
  const h = hashKey(raw);
  const r = db.prepare("SELECT k.id, k.tenant_id, k.repo_id, k.prefix, k.key_hash, k.created_by, r.repo, r.tenant_id AS rt FROM api_keys k JOIN team_repos r ON r.id = k.repo_id WHERE k.key_hash = ? AND k.revoked_at IS NULL").get(h) as
    { id: number; tenant_id: number; repo_id: number; prefix: string; key_hash: string; created_by: number | null; repo: string; rt: number } | undefined;
  if (!r || r.rt !== r.tenant_id || r.created_by === null) return null;
  if (!timingSafeEqual(Buffer.from(r.key_hash), Buffer.from(h))) return null;
  if (!canManageKeys(db, { id: r.created_by, role: "", tenantId: r.tenant_id })) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, r.id);
  return { keyId: r.id, tenantId: r.tenant_id, repoId: r.repo_id, repo: r.repo, prefix: r.prefix, userId: r.created_by, email: `api-key:${r.id}` };
}

export function apiAudit(db: DB, a: { tenantId: number; repoId: number | null; keyId: number | null; actor: string; action: string; target: string; status: number; at?: number }) {
  db.prepare("INSERT INTO api_audit (tenant_id, repo_id, key_id, actor, action, target, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(a.tenantId, a.repoId, a.keyId, a.actor.slice(0, 200), a.action, a.target.slice(0, 300), a.status, a.at ?? Date.now());
}
