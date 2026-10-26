// Job 8: any team member can add repos; shared with the team only; creator/lead/designated lead/admin edit or remove; audited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, canEditRepo, checkTeamRepo, listRepoAudit, listTeamRepos, removeTeamRepo, RepoError, setRepoPat, updateTeamRepo } from "../lib/repos";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t };
  };
  return {
    db, admin: mk("admin@a.com", "admin", "team-a"), lead: mk("lead@a.com", "team_lead", "team-a"),
    m1: mk("m1@a.com", "member", "team-a"), m2: mk("m2@a.com", "member", "team-a"), dl: mk("dl@a.com", "member", "team-a"),
    bm: mk("m@b.com", "member", "team-b"), bLead: mk("lead@b.com", "team_lead", "team-b"),
  };
}
const status = (f: () => unknown) => { try { f(); return 0; } catch (e) { assert.ok(e instanceof RepoError); return e.status; } };

test("a member adds a repo: recorded creator, visible and usable for the whole team only", () => {
  const { db, m1, m2, lead, bm, bLead } = setup();
  const r = addTeamRepo(db, m1, "acme/app", "main");
  assert.equal(r.createdBy, m1.id);
  assert.equal(r.createdByEmail, "m1@a.com");
  for (const u of [m2, lead]) {
    assert.deepEqual(listTeamRepos(db, u.tenantId).map((x) => x.repo), ["acme/app"]);
    assert.equal(checkTeamRepo(db, u.tenantId, "acme/app"), null);
  }
  assert.deepEqual(listTeamRepos(db, bm.tenantId), []);
  assert.match(checkTeamRepo(db, bm.tenantId, "acme/app")!, /not registered/);
  // team B can't edit/remove it (it's not in their team), and may register the same name independently
  assert.equal(status(() => updateTeamRepo(db, bLead, "acme/app", "dev")), 404);
  assert.equal(status(() => removeTeamRepo(db, bLead, "acme/app")), 404);
  addTeamRepo(db, bm, "acme/app");
  assert.equal(listTeamRepos(db, m1.tenantId)[0].defaultBranch, "main");
  assert.equal(listTeamRepos(db, bm.tenantId)[0].createdByEmail, "m@b.com");
  // audit is per team
  assert.deepEqual(listRepoAudit(db, m1.tenantId).map((a) => [a.actorEmail, a.action, a.repo]), [["m1@a.com", "add", "acme/app"]]);
  assert.deepEqual(listRepoAudit(db, bm.tenantId).map((a) => a.actorEmail), ["m@b.com"]);
});

test("edit/remove: creator, team lead, designated lead, admin; not other members; tokens stay lead/admin", () => {
  const { db, admin, lead, m1, m2, dl } = setup();
  db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(dl.id, dl.tenantId);
  addTeamRepo(db, m1, "acme/a");
  const r = listTeamRepos(db, m1.tenantId)[0];
  assert.equal(canEditRepo(db, m2, r), false);
  assert.equal(status(() => updateTeamRepo(db, m2, "acme/a", "dev")), 403);
  assert.equal(status(() => removeTeamRepo(db, m2, "acme/a")), 403);
  for (const u of [m1, lead, dl, admin]) assert.equal(canEditRepo(db, u, r), true, u.email);
  assert.equal(updateTeamRepo(db, m1, "acme/a", "dev").defaultBranch, "dev");
  assert.equal(updateTeamRepo(db, dl, "acme/a", null).defaultBranch, null);
  assert.equal(status(() => updateTeamRepo(db, m1, "acme/a", "bad branch!")), 400);
  // tokens: unchanged rule (admins and team leads only), even for the creator
  assert.equal(status(() => setRepoPat(db, m1, "acme/a", "ghp_" + "x".repeat(30), undefined)), 403);
  // seeded/legacy repos (no creator) are lead/admin only
  db.prepare("INSERT INTO team_repos (tenant_id, repo, created_at) VALUES (?, 'legacy/one', 1)").run(m1.tenantId);
  assert.equal(status(() => removeTeamRepo(db, m1, "legacy/one")), 403);
  removeTeamRepo(db, lead, "legacy/one");
  removeTeamRepo(db, m1, "acme/a");
  assert.deepEqual(listTeamRepos(db, m1.tenantId), []);
  assert.deepEqual(listRepoAudit(db, m1.tenantId).map((a) => [a.actorEmail, a.action, a.repo, a.detail]), [
    ["m1@a.com", "remove", "acme/a", ""],
    ["lead@a.com", "remove", "legacy/one", ""],
    ["dl@a.com", "edit", "acme/a", "default branch: dev to repo default"],
    ["m1@a.com", "edit", "acme/a", "default branch: repo default to dev"],
    ["m1@a.com", "add", "acme/a", ""],
  ]);
});

test("UI: add form shown to members, token field only for leads/admins", async () => {
  const { readFileSync } = await import("node:fs");
  const s = readFileSync(new URL("../components/workflows.tsx", import.meta.url), "utf8");
  assert.match(s, /\{canAdd \? \(/);
  assert.match(s, /\{canManage && <input aria-label="Personal access token \(optional\)"/);
  assert.match(readFileSync(new URL("../components/repos.tsx", import.meta.url), "utf8"), /canAdd=\{canAddRepo\(user\)\}/);
});

test("Settings > Repos UI: no recent-changes card or token/helper copy; audit data still recorded and served", async () => {
  const { readFileSync } = await import("node:fs");
  const repos = readFileSync(new URL("../components/repos.tsx", import.meta.url), "utf8");
  const wf = readFileSync(new URL("../components/workflows.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(repos, /Recent repo changes|listRepoAudit/);
  assert.doesNotMatch(wf, /Anyone on the team can add a repo|token is used/);
  assert.match(readFileSync(new URL("../app/api/repos/route.ts", import.meta.url), "utf8"), /audit: listRepoAudit\(db, u\.tenantId\)/);
});

test("Settings > Team UI: no 'None set' designated-lead text; lead shown when set", async () => {
  const { readFileSync } = await import("node:fs");
  const v = readFileSync(new URL("../components/team.tsx", import.meta.url), "utf8");
  assert.ok(!v.includes("None set"));
  assert.ok(v.includes("{d && <p") && v.includes("data-designated-lead>{d.email}") && v.includes("DesignatedLeadForm"));
});

test("Settings > Team UI: Join requests only when pending, no Recent team changes; APIs kept", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const v = readFileSync(new URL("../components/team.tsx", import.meta.url), "utf8");
  for (const s of ["Recent team changes", "listTeamAudit", "No join requests."]) assert.ok(!v.includes(s), s);
  assert.ok(v.includes('{reqs.some((r) => r.status === "pending") && <Card title="Join requests"'), "join requests only when one is pending");
  assert.ok(existsSync(new URL("../app/api/team/join-requests/[id]/route.ts", import.meta.url)));
  assert.match(readFileSync(new URL("../lib/team.ts", import.meta.url), "utf8"), /export function listTeamAudit/);
});
