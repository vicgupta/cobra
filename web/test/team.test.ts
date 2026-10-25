// Job 25: Settings > Team roles and designated lead (lib/team.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError, designatedLead } from "../lib/collab";
import { designate, listTeamAudit, pickDesignatedLead, setMemberRole, teamMembers } from "../lib/team";
import type { Actor } from "../lib/workflows/store";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const root = mk("root@a.com", "admin", "team-a"); // user 1: never changed
  const admin = mk("admin@a.com", "admin", "team-a"), lead = mk("lead@a.com", "team_lead", "team-a"), lead2 = mk("lead2@a.com", "team_lead", "team-a");
  const member = mk("member@a.com", "member", "team-a"), m2 = mk("m2@a.com", "member", "team-a"), other = mk("x@b.com", "member", "team-b");
  return { db, root, admin, lead, lead2, member, m2, other };
}
const st = (n: number) => (e: unknown) => e instanceof CollabError && e.status === n;
const role = (db: ReturnType<typeof openDb>, id: number) => (db.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: string }).role;

test("team: members list; lead promotes a member (200), member can't promote (403)", () => {
  const { db, lead, member, m2, other } = setup();
  assert.equal(root1(db), 1);
  assert.equal(teamMembers(db, lead.tenantId).length, 6);
  assert.equal(setMemberRole(db, lead, member.id, "team_lead").role, "team_lead");
  assert.throws(() => setMemberRole(db, m2, lead.id, "member"), st(403));
  assert.throws(() => setMemberRole(db, m2, m2.id, "team_lead"), st(403), "member can't promote (even self)");
  assert.throws(() => setMemberRole(db, lead, other.id, "team_lead"), st(404), "other team");
  assert.equal(role(db, other.id), "member");
});
const root1 = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT id FROM users WHERE email = 'root@a.com'").get() as { id: number }).id;

test("team: lead demotes another lead (200), not themselves (403), not the designated lead (403)", () => {
  const { db, admin, lead, lead2, member } = setup();
  setMemberRole(db, lead, member.id, "team_lead");
  assert.equal(setMemberRole(db, lead, member.id, "member").role, "member");
  assert.throws(() => setMemberRole(db, lead, lead.id, "member"), (e) => st(403)(e) && /themselves/.test((e as Error).message));
  designate(db, admin, lead2.id);
  assert.throws(() => setMemberRole(db, lead, lead2.id, "member"), (e) => st(403)(e) && /designated lead/.test((e as Error).message));
  assert.equal(role(db, lead2.id), "team_lead");
});

test("team: designated lead is admin-only; make designated lead promotes; admin demote unsets; admin/user 1 protected; audit", () => {
  const { db, root, admin, lead, lead2, member } = setup();
  assert.throws(() => pickDesignatedLead(db, lead, lead.id), st(403));
  assert.throws(() => designate(db, lead, member.id), st(403));
  assert.throws(() => designate(db, lead, null), st(403));
  assert.throws(() => pickDesignatedLead(db, admin, member.id), st(400), "picker only lists leads");
  assert.deepEqual(designate(db, admin, member.id), { id: member.id, email: member.email });
  assert.equal(role(db, member.id), "team_lead");
  assert.equal(pickDesignatedLead(db, admin, lead2.id)!.id, lead2.id);
  assert.equal(designate(db, admin, null), null);
  designate(db, admin, lead.id);
  setMemberRole(db, admin, lead.id, "member");
  assert.equal(designatedLead(db, admin.tenantId), null, "demoting the designated lead unsets it");
  assert.throws(() => setMemberRole(db, admin, root.id, "member"), st(403));
  assert.throws(() => setMemberRole(db, admin, admin.id, "team_lead"), st(403), "admin roles not changed here");
  assert.throws(() => setMemberRole(db, admin, member.id, "admin"), st(400));
  assert.throws(() => designate(db, admin, root.id), st(403));
  assert.equal(role(db, root.id), "admin");
  const actions = listTeamAudit(db, admin.tenantId).map((r) => r.action);
  for (const a of ["promote", "designate", "clear_designated", "demote"]) assert.ok(actions.includes(a as never), a);
});
