// System admins can create a team and join an existing one (lib/admin-teams.ts, /api/team/teams).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { createTeam, joinTeam, listTeams } from "../lib/admin-teams";
import { createSkill, getSkill, listSkills, type Actor } from "../lib/skills/store";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, tenant: string, role: "admin" | "team_lead" | "member") => {
    const id = createUser(db, { email, tenant, tenantName: tenant === "team-b" ? "Team B" : undefined, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const admin = mk("vic@a.com", "default", "admin");
  const lead = mk("lead@b.com", "team-b", "team_lead");
  const member = mk("m@a.com", "default", "member");
  return { db, admin, lead, member };
}
const tenantOf = (db: ReturnType<typeof openDb>, id: number) => (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
const actions = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT tenant_id t, action FROM team_audit ORDER BY id").all() as Array<{ t: number; action: string }>);

test("system admin creates a team (unique slug) and moves into it; audited", () => {
  const { db, admin } = setup();
  const t = createTeam(db, admin, "  Growth   Team ", undefined, 1000);
  assert.deepEqual({ name: t.name, slug: t.slug, joined: t.joined }, { name: "Growth Team", slug: "growth-team", joined: true });
  assert.equal(tenantOf(db, admin.id), t.id);
  assert.deepEqual(actions(db).map((a) => a.action), ["team_create", "invite_accept"]);
  const t2 = createTeam(db, { ...admin, tenantId: t.id }, "Default", false);
  assert.equal(t2.slug, "default-2", "reserved/taken slug gets a suffix");
  assert.equal(t2.joined, false);
  assert.equal(tenantOf(db, admin.id), t.id, "join:false keeps the admin where they are");
  assert.throws(() => createTeam(db, admin, "growth team"), (e: CollabError) => e.status === 409);
  assert.throws(() => createTeam(db, admin, "   "), (e: CollabError) => e.status === 400);
});

test("system admin joins an existing team; designated-lead cleared on the old team", () => {
  const { db, admin, lead } = setup();
  db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(admin.id, admin.tenantId);
  const r = joinTeam(db, admin, lead.tenantId);
  assert.equal(r.name, "Team B");
  assert.equal(tenantOf(db, admin.id), lead.tenantId);
  assert.equal((db.prepare("SELECT designated_lead_user_id d FROM tenants WHERE id = ?").get(admin.tenantId) as { d: number | null }).d, null);
  assert.throws(() => joinTeam(db, { ...admin, tenantId: lead.tenantId }, lead.tenantId), (e: CollabError) => e.status === 409);
  assert.throws(() => joinTeam(db, admin, 999), (e: CollabError) => e.status === 404);
  assert.throws(() => joinTeam(db, admin, "1"), (e: CollabError) => e.status === 400);
  const teams = listTeams(db, admin);
  assert.deepEqual(teams.map((t) => [t.slug, t.current]), [["team-b", true], ["default", false]].sort((a, b) => (a[0] < b[0] ? 1 : -1)) as Array<[string, boolean]>);
});

test("non-admins can't create, join or list teams (role read fresh)", () => {
  const { db, admin, lead, member } = setup();
  for (const u of [lead, member]) {
    assert.throws(() => createTeam(db, u, "X"), (e: CollabError) => e.status === 403);
    assert.throws(() => joinTeam(db, u, admin.tenantId === u.tenantId ? lead.tenantId : admin.tenantId), (e: CollabError) => e.status === 403);
    assert.throws(() => listTeams(db, u), (e: CollabError) => e.status === 403);
  }
  db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(admin.id);
  assert.throws(() => createTeam(db, admin, "X"), (e: CollabError) => e.status === 403, "stale session role isn't trusted");
});

test("team scoping intact: another team's skills stay invisible to the admin until they join it", () => {
  const { db, admin, lead } = setup();
  const s = createSkill(db, lead, { name: "b-only", description: "d", body: "# B\n\nDo it." });
  assert.equal(getSkill(db, admin, s.id), null);
  assert.ok(!listSkills(db, admin).some((x) => x.id === s.id));
  joinTeam(db, admin, lead.tenantId);
  const moved = { ...admin, tenantId: lead.tenantId };
  assert.equal(getSkill(db, moved, s.id)?.name, "b-only");
});

test("routes and UI are wired", () => {
  const r = readFileSync(new URL("../app/api/team/teams/route.ts", import.meta.url), "utf8");
  assert.match(r, /createTeam\(/); assert.match(r, /listTeams\(/); assert.match(r, /apiGuard\(req\)/);
  assert.ok(existsSync(new URL("../app/api/team/teams/[id]/join/route.ts", import.meta.url)));
  const v = readFileSync(new URL("../components/team.tsx", import.meta.url), "utf8");
  assert.match(v, /admin && \(\(\) => \{ const teams = listTeams/); assert.match(v, /<CreateTeamForm \/>/); assert.match(v, /JoinTeamButton/);
});
