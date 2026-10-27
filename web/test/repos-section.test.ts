// Job 31: Repos section. Branches visibility, Cobra-branch hiding, activity feed, redirects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, RepoError } from "../lib/repos";
import { activityFeed, branchRepoGate, branchRepos, isCobraBranch, visibleBranches } from "../lib/repo-hub";
import { REPOS_TABS } from "../components/repos-tabs";
import nextConfig from "../next.config";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t };
  };
  const admin = mk("admin@a.com", "admin", "team-a"), lead = mk("lead@a.com", "team_lead", "team-a"), lead2 = mk("lead2@a.com", "team_lead", "team-a"), member = mk("member@a.com", "member", "team-a");
  const bLead = mk("lead@b.com", "team_lead", "team-b");
  addTeamRepo(db, lead, "acme/one", "main");
  addTeamRepo(db, lead2, "acme/two", "main"); // added by another teammate
  addTeamRepo(db, lead, "vicgupta/cobra", "main");
  addTeamRepo(db, bLead, "other/three", "main");
  return { db, admin, lead, member, bLead };
}
const code = (f: () => unknown) => { try { f(); return 0; } catch (e) { assert.ok(e instanceof RepoError); return e.status; } };

test("branches: members and leads see the whole team's repos, never vicgupta/cobra or other teams", () => {
  const { db, lead, member } = setup();
  for (const u of [member, lead]) {
    assert.deepEqual(branchRepos(db, u), ["acme/one", "acme/two"]);
    assert.equal(branchRepoGate(db, u, "ACME/two"), "acme/two");
    assert.equal(code(() => branchRepoGate(db, u, "vicgupta/cobra")), 403);
    assert.equal(code(() => branchRepoGate(db, u, "other/three")), 404);
    assert.equal(code(() => branchRepoGate(db, u, "not a repo")), 400);
  }
});

test("branches: admins see team repos and other teams' repos, still never vicgupta/cobra", () => {
  const { db, admin } = setup();
  assert.deepEqual(branchRepos(db, admin).sort(), ["acme/one", "acme/two", "other/three"]);
  assert.equal(code(() => branchRepoGate(db, admin, "vicgupta/cobra")), 403);
  assert.equal(code(() => branchRepoGate(db, admin, "other/three")), 0);
});

test("branches: cobra/* working branches are dropped for everyone", () => {
  const bs = [{ name: "main" }, { name: "cobra/r-123" }, { name: "Cobra/x" }, { name: "feature/cobra" }];
  assert.deepEqual(visibleBranches(bs).map((b) => b.name), ["main", "feature/cobra"]);
  assert.equal(isCobraBranch("cobra/abc"), true);
});

test("activity: team repos only, newest first, audit + runs + finished steps", () => {
  const { db, lead, bLead } = setup();
  const ins = (id: string, t: number, repo: string, at: number) => db.prepare("INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, started_at, status) VALUES (?, ?, NULL, 'a', ?, 0, 't', ?, 'succeeded')").run(id, t, repo, at);
  ins("r1", lead.tenantId, "acme/one", 100); ins("r2", bLead.tenantId, "other/three", 150);
  db.prepare("INSERT INTO run_step_events (run_id, tenant_id, step_id, status, at) VALUES ('r1', ?, 's', 'succeeded', 300)").run(lead.tenantId);
  db.prepare("INSERT INTO collab_audit (tenant_id, actor_email, action, repo, number, at) VALUES (?, 'lead@a.com', 'merge', 'acme/two', 7, 200)").run(lead.tenantId);
  const f = activityFeed(db, lead.tenantId);
  assert.deepEqual(f.map((x) => [x.kind, x.at]), [["step", 300], ["audit", 200], ["run", 100]]);
  assert.deepEqual(activityFeed(db, lead.tenantId, "acme/two").map((x) => x.kind), ["audit"]);
});

test("repos tabs and redirects", async () => {
  assert.deepEqual(REPOS_TABS.map(([, l]) => l), ["Overview", "Issues", "Pull Requests", "Branches", "Activity"]);
  const r = await nextConfig.redirects!();
  const by = (s: string) => r.find((x) => x.source === s);
  assert.equal(by("/repos")?.destination, "/repos/overview");
  assert.equal(by("/issues/:path*")?.destination, "/repos/issues/:path*");
  assert.equal(by("/pulls/:path*")?.destination, "/repos/pull-requests/:path*");
  assert.ok(r.filter((x) => !x.source.startsWith("/skills")).every((x) => x.permanent === false && x.destination !== "/settings/repos"));
});
