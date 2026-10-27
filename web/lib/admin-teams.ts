// System admins (role 'admin') can create a team and move themselves into any existing team.
// A user belongs to exactly one team (users.tenant_id), so "joining" a team moves the admin there;
// everything team-scoped (skills, agents, repos, tasks) then follows the new team as usual.
// Audited in team_audit (team_create; a self-join is invite_accept with a 'system admin self-join' detail).
import type { DB } from "./db";
import { CollabError, isSystemAdmin } from "./collab";
import { uniqueSlug } from "./registration";

export type TeamActor = { id: number; email: string; role: string; tenantId: number };
export type TeamRow = { id: number; name: string; slug: string; members: number; current: boolean };

const freshUser = (db: DB, u: TeamActor) =>
  db.prepare("SELECT role, tenant_id tenantId FROM users WHERE id = ?").get(u.id) as { role: string; tenantId: number } | undefined;

function requireAdmin(db: DB, u: TeamActor) {
  const f = freshUser(db, u);
  if (!f || !isSystemAdmin({ role: f.role })) throw new CollabError(403, "only system admins can create or join teams");
  return f;
}

const audit = (db: DB, tenantId: number, u: TeamActor, action: string, detail: string, now: number) =>
  db.prepare("INSERT INTO team_audit (tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(tenantId, u.id, u.email, action, u.id, u.email, detail.slice(0, 500), now);

export function listTeams(db: DB, u: TeamActor): TeamRow[] {
  const f = requireAdmin(db, u);
  const rows = db.prepare("SELECT t.id, t.name, t.slug, (SELECT count(*) FROM users x WHERE x.tenant_id = t.id) members FROM tenants t ORDER BY lower(t.name), t.id").all() as Array<Omit<TeamRow, "current">>;
  return rows.map((r) => ({ ...r, current: r.id === f.tenantId }));
}

function moveSelf(db: DB, u: TeamActor, from: number, to: number, now: number) {
  db.prepare("UPDATE tenants SET designated_lead_user_id = NULL WHERE id = ? AND designated_lead_user_id = ?").run(from, u.id);
  db.prepare("UPDATE users SET tenant_id = ? WHERE id = ?").run(to, u.id);
  const name = (id: number) => (db.prepare("SELECT name FROM tenants WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? `#${id}`;
  // team_audit's CHECK list has no dedicated action and adding one needs a migration; a self-join is
  // recorded as invite_accept on the joined team with an explicit detail.
  audit(db, to, u, "invite_accept", `system admin self-join (no invite) from team "${name(from)}"`, now);
}

/** Creates a team (unique slug from the name). With join (default), the admin moves into it. */
export function createTeam(db: DB, u: TeamActor, name: unknown, join: unknown = true, now = Date.now()): { id: number; name: string; slug: string; joined: boolean } {
  const f = requireAdmin(db, u);
  const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (!n) throw new CollabError(400, "team name is required");
  if (db.prepare("SELECT 1 FROM tenants WHERE lower(name) = lower(?)").get(n)) throw new CollabError(409, "a team with that name already exists");
  const doJoin = join !== false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const slug = uniqueSlug(db, n);
    const id = Number(db.prepare("INSERT INTO tenants (name, slug, created_at) VALUES (?, ?, ?)").run(n, slug, now).lastInsertRowid);
    audit(db, id, u, "team_create", `team "${n}" created by a system admin`, now);
    if (doJoin) moveSelf(db, u, f.tenantId, id, now);
    db.exec("COMMIT");
    return { id, name: n, slug, joined: doJoin };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Moves the system admin into an existing team. */
export function joinTeam(db: DB, u: TeamActor, tenantId: unknown, now = Date.now()): { id: number; name: string; slug: string } {
  const f = requireAdmin(db, u);
  if (!Number.isInteger(tenantId)) throw new CollabError(400, "team id must be an integer");
  const t = db.prepare("SELECT id, name, slug FROM tenants WHERE id = ?").get(tenantId as number) as { id: number; name: string; slug: string } | undefined;
  if (!t) throw new CollabError(404, "no such team");
  if (t.id === f.tenantId) throw new CollabError(409, "you are already in this team");
  db.exec("BEGIN IMMEDIATE");
  try { moveSelf(db, u, f.tenantId, t.id, now); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { id: t.id, name: t.name, slug: t.slug };
}
