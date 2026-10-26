// Per-team workspaces (containment, legacy fallback, migration 21) and the simulated GitHub guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { assertTeamWorkspace, canAccessWorkspacePath, legacyWorkspacesDir, runWorkspacePath, teamWorkspacesDir } from "../lib/workspaces";
import { parseWorkflow } from "../lib/workflows/loader";
import { executeWorkflow } from "../lib/workflows/engine";
import { builtinHandlers, github } from "../lib/workflows/handlers";
import { createSkill, type Actor } from "../lib/skills/store";
import { startSkillRun, type SkillDeps } from "../lib/skills/executor";

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(path.join(os.tmpdir(), "cobra-teams-"));
  const prev = [process.env.COBRA_TEAMS_ROOT, process.env.COBRA_WORKSPACES_DIR];
  process.env.COBRA_TEAMS_ROOT = root; delete process.env.COBRA_WORKSPACES_DIR;
  try { return fn(root); } finally {
    if (prev[0] === undefined) delete process.env.COBRA_TEAMS_ROOT; else process.env.COBRA_TEAMS_ROOT = prev[0];
    if (prev[1] !== undefined) process.env.COBRA_WORKSPACES_DIR = prev[1];
  }
}

test("team workspaces: layout, member containment, admin access, traversal and symlink escapes", () => withRoot((root) => {
  assert.equal(teamWorkspacesDir(1), path.join(root, "1", "workspaces"));
  assert.equal(legacyWorkspacesDir(), path.join(root, "workspaces"));
  assert.throws(() => teamWorkspacesDir(0)); assert.throws(() => teamWorkspacesDir(1.5));
  const t1 = teamWorkspacesDir(1), t2 = teamWorkspacesDir(2);
  mkdirSync(path.join(t1, "run_a"), { recursive: true }); mkdirSync(t2, { recursive: true });
  const m2 = { role: "member", tenantId: 2 }, lead1 = { role: "team_lead", tenantId: 1 }, admin = { role: "admin", tenantId: 1 };
  assert.equal(canAccessWorkspacePath(m2, path.join(t1, "run_a")), false, "team 2 member denied team 1");
  assert.equal(canAccessWorkspacePath(lead1, path.join(t1, "run_a")), true);
  assert.equal(canAccessWorkspacePath(m2, path.join(t2, "run_new")), true, "own team, not yet created");
  assert.equal(canAccessWorkspacePath(admin, path.join(t2, "x")), true, "admin any team");
  assert.equal(canAccessWorkspacePath(admin, path.join(t1, "run_a")), true);
  assert.equal(canAccessWorkspacePath(admin, "/etc/passwd"), false, "admin still contained to the teams root");
  assert.equal(canAccessWorkspacePath(m2, `${t2}/../../1/workspaces/run_a`), false, "traversal");
  assert.equal(canAccessWorkspacePath(m2, path.join(t2, "..", "x")), false);
  symlinkSync(path.join(t1, "run_a"), path.join(t2, "sneaky"));
  assert.equal(canAccessWorkspacePath(m2, path.join(t2, "sneaky")), false, "symlink escape");
  assert.equal(canAccessWorkspacePath(m2, path.join(t2, "sneaky", "deeper", "file")), false, "through a symlink, missing tail");
  assert.throws(() => assertTeamWorkspace(2, path.join(t2, "sneaky")), /escapes/);
  assert.doesNotThrow(() => assertTeamWorkspace(2, path.join(t2, "run_ok")));
  // a whole team dir symlinked elsewhere is caught too
  mkdirSync(path.join(root, "3"), { recursive: true }); symlinkSync(t1, path.join(root, "3", "workspaces"));
  assert.equal(canAccessWorkspacePath({ role: "member", tenantId: 3 }, path.join(t1, "run_a")), true, "team 3's dir IS that real dir (resolved both sides)");
  assert.equal(canAccessWorkspacePath(m2, path.join(root, "3", "workspaces", "run_a")), false);
}));

test("legacy fallback: old runs still resolve from the shared dir; new runs go to the team dir", () => withRoot((root) => {
  mkdirSync(path.join(root, "workspaces", "run_old"), { recursive: true });
  assert.equal(runWorkspacePath(1, "run_old"), path.join(root, "workspaces", "run_old"));
  assert.equal(runWorkspacePath(1, "run_new"), path.join(root, "1", "workspaces", "run_new"));
  mkdirSync(path.join(root, "1", "workspaces", "run_old"), { recursive: true });
  assert.equal(runWorkspacePath(1, "run_old"), path.join(root, "1", "workspaces", "run_old"), "moved: team dir wins");
  assert.throws(() => runWorkspacePath(1, "../x"), /invalid run id/);
}));

test("migration 21 rewrites stored legacy workspace paths to the run's team dir", () => withRoot((root) => {
  const db = openDb(":memory:");
  createUser(db, { email: "a@x.com", tenant: "default", role: "admin", password: "pw-1234567890" });
  createUser(db, { email: "b@y.com", tenant: "other", tenantName: "Other", role: "member", password: "pw-1234567890" });
  const tid = (e: string) => (db.prepare("SELECT tenant_id t FROM users WHERE email = ?").get(e) as { t: number }).t;
  const [t1, t2] = [tid("a@x.com"), tid("b@y.com")];
  const legacy = path.join(root, "workspaces");
  for (const [id, t] of [["run_1", t1], ["run_2", t2]] as const) {
    db.prepare("INSERT INTO runs (id, tenant_id, agent, repo, issue, title, started_at) VALUES (?, ?, 'a', '', 0, 't', 1)").run(id, t);
    db.prepare("INSERT INTO run_step_events (run_id, tenant_id, step_id, status, output, at) VALUES (?, ?, 's', 'succeeded', ?, 1)").run(id, t, `[cobra] workspace ${legacy}/${id}\nnot ${legacy}x/keep`);
  }
  db.exec("PRAGMA user_version = 20"); migrate(db, 21);
  const out = (id: string) => (db.prepare("SELECT output o FROM run_step_events WHERE run_id = ?").get(id) as { o: string }).o;
  assert.equal(out("run_1"), `[cobra] workspace ${root}/${t1}/workspaces/run_1\nnot ${legacy}x/keep`);
  assert.equal(out("run_2"), `[cobra] workspace ${root}/${t2}/workspaces/run_2\nnot ${legacy}x/keep`);
}));

// ---- simulated runs never write to GitHub
function fakeGithub() {
  const calls: { method: string; url: string }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ method: String(init?.method ?? "GET"), url: String(url) });
    return new Response(JSON.stringify({ number: 7, html_url: "https://x/7", sha: "abc", merged: init?.method === "PUT", state: "open", head: { sha: "abc" }, default_branch: "main", title: "t", body: "" }), { status: 200 });
  }) as typeof fetch;
  return { calls, f, writes: () => calls.filter((c) => c.method !== "GET").length };
}
const collab = { canMerge: () => true, who: "t@x.com", audit: () => {} };
const WF = `
name: gh-writes
version: 1
governance:
  owner: owner@x.com
  approvers: [{ role: admin }]
steps:
  - { id: i1, uses: github, with: { action: create-issue, repo: acme/app, title: t }, secrets: [GITHUB_TOKEN] }
  - { id: i2, uses: github, with: { action: issue_create, repo: acme/app, title: t }, secrets: [GITHUB_TOKEN] }
  - { id: p1, uses: github, with: { action: create-pr, repo: acme/app, title: t, head: x }, secrets: [GITHUB_TOKEN] }
  - { id: m1, uses: github, with: { action: merge-pr, repo: acme/app, pr: 7 }, secrets: [GITHUB_TOKEN] }
  - { id: m2, uses: github, with: { action: merge, repo: acme/app, pr: 7, mode: real }, secrets: [GITHUB_TOKEN] }
`;

test("workflow: a simulated run makes zero GitHub write calls (create-pr, issues, merges), even with mode: real on a step", async () => {
  const gh = fakeGithub();
  const handlers = builtinHandlers({ fetch: gh.f, checkRepo: () => null, tokenFor: () => "tok", collab });
  const logs: string[] = [];
  const r = await executeWorkflow(parseWorkflow(WF), { runId: "sim1", isApproved: () => true, resolveSecret: () => "tok", handlers, run: { mode: "simulated" }, onEvent: (e) => { if (e.type === "log") logs.push(e.chunk); } });
  assert.equal(r.status, "succeeded", JSON.stringify(r.steps));
  assert.equal(gh.writes(), 0, "zero write calls");
  assert.equal(gh.calls.length, 0, "no GitHub call at all");
  assert.match(logs.join(""), /simulated: would open a PR on acme\/app/);
  // control: the same fake does see writes on a real run (the guard, not the fake, is what stops them)
  const live = fakeGithub();
  const r2 = await executeWorkflow(parseWorkflow(WF), { runId: "real1", isApproved: () => true, resolveSecret: () => "tok", handlers: builtinHandlers({ fetch: live.f, checkRepo: () => null, tokenFor: () => "tok", collab }), run: { mode: "real" } });
  assert.equal(r2.status, "succeeded", JSON.stringify(r2.steps));
  assert.ok(live.writes() >= 5);
  // the handler on its own: mode: simulated short-circuits every write action
  const solo = fakeGithub(); const h = github(solo.f, () => null, () => "tok", { collab });
  for (const action of ["create-issue", "create-pr", "merge-pr", "issue_create", "merge", "pr_from_issue"]) {
    const out = await h({ runId: "x", step: { id: "s" } as never, with: { action, repo: "acme/app", title: "t", pr: 7, issue: 1, mode: "simulated" }, secrets: {}, signal: new AbortController().signal });
    assert.equal(out.simulated, true, action);
  }
  assert.equal(solo.calls.length, 0);
});

test("skill: a simulated run with the real github handler on a fake client makes zero write calls", async () => {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "m@x.com", tenant: "default", role: "member", password: "pw-1234567890" });
  const u = { id, email: "m@x.com", role: "member", tenantId: (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t } as Actor;
  const gh = fakeGithub();
  const deps: SkillDeps = { handlers: builtinHandlers({ fetch: gh.f, checkRepo: () => null, tokenFor: () => "tok", collab }), resolveSecret: () => undefined, redact: () => [] };
  const s = createSkill(db, u, { name: "gh", description: "d", plan: { steps: [
    { id: "issue", action: "github", with: { action: "issue_create", title: "t" }, on_failure: "stop", outputs: {} },
    { id: "pr", action: "github", with: { action: "create-pr", title: "t", head: "x" }, on_failure: "stop", outputs: {} },
    { id: "merge", action: "github", with: { action: "merge-pr", pr: "7" }, on_failure: "stop", outputs: {} }] } });
  const r = await startSkillRun(db, { tenantId: u.tenantId, userId: u.id, email: u.email }, s, {}, deps, { repo: "acme/app" }).done;
  assert.equal(r.status, "succeeded", r.error);
  assert.equal(gh.writes(), 0);
  assert.equal(gh.calls.length, 0);
});
