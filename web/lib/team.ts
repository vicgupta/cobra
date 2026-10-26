// Job 25: team members, roles and the designated lead (Settings > Team). Rules, all enforced here:
// - everyone on the team sees the designated lead and the members (email, role);
// - promote member -> team_lead: system admins, or any team lead of the same team;
// - demote team_lead -> member: system admins (anyone); team leads only other leads of their team,
//   never themselves and never the current designated lead (that changes merge rights: admin-only);
// - set / change / clear the designated lead ("Make designated lead" promotes + designates): system admins only;
// - never grant or remove admin here, never change user 1, never touch other teams;
// - demoting the designated lead unsets the designation. Every change writes a team_audit row.
import type { DB } from "./db";
import { CollabError, designatedLead, isSystemAdmin } from "./collab";
import type { Actor } from "./workflows/store";

export type Member = { id: number; email: string; name: string; role: "admin" | "team_lead" | "member" };
export type TeamAction = "promote" | "demote" | "designate" | "clear_designated" | "notify_toggle" | "notify_recipients" | "notify_optout" | "notify_optin" | "notify_test";
const PROTECTED_USER_ID = 1;

export function teamMembers(db: DB, tenantId: number): Member[] {
  return (db.prepare("SELECT id, email, coalesce(name, '') AS name, role FROM users WHERE tenant_id = ? ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'team_lead' THEN 1 ELSE 2 END, email").all(tenantId) as Member[])
    .map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role }));
}

function teamAudit(db: DB, u: Actor, action: TeamAction, target: { id: number; email: string } | null, detail = "") {
  db.prepare("INSERT INTO team_audit (tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, u.id, u.email, action, target?.id ?? null, target?.email ?? null, detail.slice(0, 500), Date.now());
}

export function listTeamAudit(db: DB, tenantId: number, limit = 50) {
  return db.prepare("SELECT actor_email actorEmail, action, target_email targetEmail, detail, at FROM team_audit WHERE tenant_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(tenantId, limit) as Array<{ actorEmail: string; action: TeamAction; targetEmail: string | null; detail: string; at: number }>;
}

function target(db: DB, u: Actor, userId: number): Member {
  if (!Number.isInteger(userId)) throw new CollabError(400, "userId must be a user id");
  const m = teamMembers(db, u.tenantId).find((x) => x.id === userId);
  if (!m) throw new CollabError(404, "no such member on this team");
  if (m.id === PROTECTED_USER_ID) throw new CollabError(403, "this account's role can't be changed here");
  if (m.role === "admin") throw new CollabError(403, "system admin roles can't be changed here");
  return m;
}

const roleFor = (db: DB, u: Actor) => (db.prepare("SELECT role FROM users WHERE id = ?").get(u.id) as { role: string } | undefined)?.role ?? u.role;

/** Change a member's role between member and team_lead (see the rules above). */
export function setMemberRole(db: DB, u: Actor, userId: number, role: unknown): Member {
  if (role !== "member" && role !== "team_lead") throw new CollabError(400, "role must be member or team_lead");
  const actorRole = roleFor(db, u);
  const admin = isSystemAdmin({ role: actorRole }), lead = actorRole === "team_lead";
  if (!admin && !lead) throw new CollabError(403, "only system admins and team leads can change roles");
  const m = target(db, u, userId);
  if (m.role === role) return m;
  if (role === "member" && !admin) {
    if (m.id === u.id) throw new CollabError(403, "team leads can't demote themselves; ask a system admin");
    if (designatedLead(db, u.tenantId)?.id === m.id) throw new CollabError(403, "the designated lead can only be demoted by a system admin (it changes merge rights)");
  }
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE users SET role = ? WHERE id = ? AND tenant_id = ?").run(role, m.id, u.tenantId);
    teamAudit(db, u, role === "team_lead" ? "promote" : "demote", m, `${m.role} -> ${role}`);
    if (role === "member" && designatedLead(db, u.tenantId)?.id === m.id) {
      db.prepare("UPDATE tenants SET designated_lead_user_id = NULL WHERE id = ?").run(u.tenantId);
      teamAudit(db, u, "clear_designated", m, "demoted to member");
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { ...m, role };
}

/** System admins only: set (promoting a member to team_lead first) or clear (null) the designated lead. */
export function designate(db: DB, u: Actor, userId: number | null): { id: number; email: string } | null {
  if (!isSystemAdmin({ role: roleFor(db, u) })) throw new CollabError(403, "only system admins can set or clear the designated lead");
  const before = designatedLead(db, u.tenantId);
  if (userId === null) {
    db.prepare("UPDATE tenants SET designated_lead_user_id = NULL WHERE id = ?").run(u.tenantId);
    if (before) teamAudit(db, u, "clear_designated", before);
    return null;
  }
  const m = target(db, u, userId);
  db.exec("BEGIN");
  try {
    if (m.role !== "team_lead") {
      db.prepare("UPDATE users SET role = 'team_lead' WHERE id = ? AND tenant_id = ?").run(m.id, u.tenantId);
      teamAudit(db, u, "promote", m, `${m.role} -> team_lead (make designated lead)`);
    }
    db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(m.id, u.tenantId);
    teamAudit(db, u, "designate", m, before ? `was ${before.email}` : "was none");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return designatedLead(db, u.tenantId);
}

/** The picker: system admins choose from the team's current team leads (null clears). Audited. */
export function pickDesignatedLead(db: DB, u: Actor, userId: number | null): { id: number; email: string } | null {
  if (!isSystemAdmin({ role: roleFor(db, u) })) throw new CollabError(403, "only system admins can set or clear the designated lead");
  if (userId !== null && !teamMembers(db, u.tenantId).some((m) => m.id === userId && m.role === "team_lead")) throw new CollabError(400, "the designated lead must be one of this team's team leads");
  return designate(db, u, userId);
}
