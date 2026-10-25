// Job 11 workflow redesign: per-team repos, team templates + attach, engine, prompt, local runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, checkTeamRepo, listTeamRepos, removeTeamRepo, RepoError } from "../lib/repos";
import { parseWorkflow } from "../lib/workflows/loader";
import { recordDecision } from "../lib/workflows/approvals";
import { builtinHandlers, github } from "../lib/workflows/handlers";
import { localRunner } from "../lib/workflows/local-runner";
import { getRunDetail, listWorkflowRuns } from "../lib/workflows/runner";
import { findWorkflow, instancesOf, seedTemplates, type Actor } from "../lib/workflows/store";
import { attachTemplate, saveWorkflow, startRun, workflowDetail, type RunDeps } from "../lib/workflows/service";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const a = mk("admin@a.com", "admin", "team-a"), lead = mk("lead@a.com", "team_lead", "team-a"), member = mk("member@a.com", "member", "team-a");
  const b = mk("admin@b.com", "admin", "team-b");
  return { db, a, lead, member, b };
}
const deps = (db: ReturnType<typeof openDb>, tenantId: number): RunDeps => ({
  handlers: builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, tenantId, r) }), resolveSecret: () => undefined, redact: () => [],
});
const wfYaml = (name: string, extra = "") => `name: ${name}
version: 1
${extra}governance:
  owner: owner@a.com
  approvers: [{ role: admin }]
inputs:
  task: { type: string, default: add a README }
steps:
  - id: agent
    uses: agent
    with: { driver: "\${{ run.engine }}", mode: "\${{ run.mode }}", repo: "\${{ run.repo }}", prompt: "\${{ run.prompt }}" }
    outputs: { summary: "\${{ result.summary }}" }
`;
async function approved(db: ReturnType<typeof openDb>, u: Actor, src: string) {
  const r = await saveWorkflow(db, u, { source: src });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const name = (r.body as { name: string }).name;
  recordDecision(db, u, findWorkflow(db, u.tenantId, name)!, "approve");
  return name;
}

test("repos: per-team lists; admin/lead manage, members view only; team A can't use team B's repo", () => {
  const { db, a, lead, member, b } = setup();
  addTeamRepo(db, a, "vicgupta/factory-demo-app", "main");
  addTeamRepo(db, lead, "vicgupta/cobra-sandbox");
  addTeamRepo(db, b, "other/b-repo");
  assert.throws(() => addTeamRepo(db, member, "x/y"), (e: unknown) => e instanceof RepoError && e.status === 403);
  assert.throws(() => addTeamRepo(db, a, "not a repo"), (e: unknown) => e instanceof RepoError && e.status === 400);
  assert.throws(() => addTeamRepo(db, a, "vicgupta/cobra-sandbox"), (e: unknown) => e instanceof RepoError && e.status === 409);
  assert.deepEqual(listTeamRepos(db, a.tenantId).map((r) => r.repo), ["vicgupta/cobra-sandbox", "vicgupta/factory-demo-app"]);
  assert.deepEqual(listTeamRepos(db, b.tenantId).map((r) => r.repo), ["other/b-repo"]);
  assert.equal(checkTeamRepo(db, a.tenantId, "vicgupta/factory-demo-app"), null);
  assert.match(checkTeamRepo(db, a.tenantId, "other/b-repo")!, /not registered/);
  assert.match(checkTeamRepo(db, b.tenantId, "vicgupta/factory-demo-app")!, /not registered/);
  // global ceiling: must be in both lists
  process.env.COBRA_GITHUB_ALLOWED_REPOS = "vicgupta/factory-demo-app";
  try { assert.match(checkTeamRepo(db, a.tenantId, "vicgupta/cobra-sandbox")!, /ALLOWED_REPOS/); assert.equal(checkTeamRepo(db, a.tenantId, "vicgupta/factory-demo-app"), null); }
  finally { delete process.env.COBRA_GITHUB_ALLOWED_REPOS; }
  assert.throws(() => removeTeamRepo(db, member, "vicgupta/cobra-sandbox"), RepoError);
  removeTeamRepo(db, lead, "vicgupta/cobra-sandbox");
  assert.equal(listTeamRepos(db, a.tenantId).length, 1);
});

test("regression: rows passed to Client Components are plain objects (node:sqlite rows have a null prototype)", () => {
  const { db, a } = setup();
  addTeamRepo(db, a, "vicgupta/factory-demo-app", "main");
  const raw = db.prepare("SELECT repo FROM team_repos").get() as object;
  assert.equal(Object.getPrototypeOf(raw), null, "precondition: raw node:sqlite rows are null-prototype");
  const list = listTeamRepos(db, a.tenantId);
  assert.equal(list.length, 1);
  for (const r of list) {
    assert.equal(Object.getPrototypeOf(r), Object.prototype);
    assert.deepEqual(Object.keys(r).sort(), ["createdAt", "defaultBranch", "repo"]);
  }
  for (const r of [...listWorkflowRuns(db, a.tenantId, "x"), ...instancesOf(db, a.tenantId, "x")]) assert.equal(Object.getPrototypeOf(r), Object.prototype);
});

test("repos: github step and GitHub file storage are checked against the team list", async () => {
  const { db, a, b } = setup();
  addTeamRepo(db, b, "other/b-repo");
  const h = github(async () => new Response("{}", { status: 200 }), (r) => checkTeamRepo(db, a.tenantId, r));
  const ctx = { runId: "r", step: { id: "g" } as never, with: { action: "create-issue", repo: "other/b-repo", title: "t" }, secrets: { GITHUB_TOKEN: "x" }, signal: new AbortController().signal };
  await assert.rejects(h(ctx), /not registered/);
  const r = await saveWorkflow(db, a, { source: wfYaml("gh"), storage: "github", github: { repo: "other/b-repo", path: "a.yaml" } });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /not registered/);
});

test("dropdown data: workflowDetail lists only the team's repos, with engine and prompt", async () => {
  const { db, a, b } = setup();
  addTeamRepo(db, a, "vicgupta/factory-demo-app", "main");
  addTeamRepo(db, b, "other/b-repo");
  const name = await approved(db, a, wfYaml("dd", "engine: codex\nprompt: 'Do: ${{ inputs.task }}'\n"));
  const d = workflowDetail(db, a, name).body as { teamRepos: string[]; engine: string; prompt: string };
  assert.deepEqual(d.teamRepos, ["vicgupta/factory-demo-app"]);
  assert.equal(d.engine, "codex");
  assert.equal(d.prompt, "Do: ${{ inputs.task }}");
});

test("templates: team template + attach creates an instance bound to a team repo", async () => {
  const { db, a, b } = setup();
  addTeamRepo(db, a, "vicgupta/factory-demo-app");
  addTeamRepo(db, b, "other/b-repo");
  const t = await saveWorkflow(db, a, { source: wfYaml("team-tpl", "template: true\n") });
  assert.equal(t.status, 201);
  assert.equal((await attachTemplate(db, a, { template: "team-tpl", repo: "other/b-repo" })).status, 400, "other team's repo");
  assert.equal((await attachTemplate(db, b, { template: "team-tpl", repo: "other/b-repo" })).status, 404, "team templates are per team");
  const r = await attachTemplate(db, a, { template: "team-tpl", repo: "vicgupta/factory-demo-app" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const name = (r.body as { name: string }).name;
  assert.equal(name, "team-tpl-factory-demo-app");
  const d = workflowDetail(db, a, name).body as { repo: string; template: boolean; createdFrom: { name: string } };
  assert.deepEqual([d.repo, d.template, d.createdFrom.name], ["vicgupta/factory-demo-app", false, "team-tpl"]);
  // system templates (global) can be attached too
  seedTemplates(db);
  const sys = await attachTemplate(db, a, { template: "issue-to-merge", repo: "vicgupta/factory-demo-app" });
  assert.equal(sys.status, 201, JSON.stringify(sys.body));
});

test("engine default + per-run override, templated vs free-form prompt; members still can't run", async () => {
  const { db, a, member } = setup();
  addTeamRepo(db, a, "vicgupta/factory-demo-app");
  const name = await approved(db, a, wfYaml("eng", "engine: codex\nprompt: 'Task: ${{ inputs.task }}'\n"));
  const d = deps(db, a.tenantId);
  const r1 = startRun(db, a, name, { inputs: { task: "write tests" }, mode: "simulated", repo: "vicgupta/factory-demo-app" }, d);
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  await r1.run!.done;
  const x1 = getRunDetail(db, r1.run!.id)!;
  assert.deepEqual([x1.engine, x1.promptSource, x1.prompt, x1.mode, x1.repo, x1.status], ["codex", "workflow", "Task: write tests", "simulated", "vicgupta/factory-demo-app", "succeeded"]);
  const r2 = startRun(db, a, name, { engine: "claude-code", promptMode: "custom", prompt: "Create HELLO.md", mode: "simulated" }, d);
  assert.equal(r2.status, 201);
  await r2.run!.done;
  const x2 = getRunDetail(db, r2.run!.id)!;
  assert.deepEqual([x2.engine, x2.promptSource, x2.prompt], ["claude-code", "custom", "Create HELLO.md"]);
  assert.match(x2.events.find((e) => e.stepId === "agent" && e.status === "succeeded")!.output!, /Simulated claude-code/);
  assert.match(x2.events[0].output!, /engine: claude-code[\s\S]*prompt \(custom\):\nCreate HELLO.md/);
  assert.equal(startRun(db, a, name, { engine: "gpt" }, d).status, 400);
  assert.equal(startRun(db, a, name, { promptMode: "custom", prompt: " " }, d).status, 400);
  assert.equal(startRun(db, a, name, { repo: "other/b-repo" }, d).status, 400, "unregistered repo");
  assert.equal(startRun(db, member, name, { promptMode: "custom", prompt: "x" }, d).status, 403);
});

test("YAML: engine/prompt optional (backward compatible) and validated", () => {
  assert.doesNotThrow(() => parseWorkflow(wfYaml("old"), "old.yaml"));
  assert.throws(() => parseWorkflow(wfYaml("bad", "engine: gpt\n"), "b.yaml"));
  assert.throws(() => parseWorkflow(wfYaml("bad", "prompt: '${{ inputs.nope }}'\n"), "b.yaml"));
});

test("local runner: clones a team repo, runs the engine CLI, streams logs, pushes cobra/<run-id> only", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-lr-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  // fake remote: <tmp>/remote/owner/app.git with a main branch
  const seed = path.join(tmp, "seed"); execFileSync("mkdir", ["-p", seed, path.join(tmp, "remote/owner")]);
  git(seed, "init", "-q", "-b", "main"); writeFileSync(path.join(seed, "README.md"), "hi\n");
  git(seed, "add", "."); git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  git(tmp, "clone", "-q", "--bare", seed, path.join(tmp, "remote/owner/app.git"));
  const fake = path.join(tmp, "fake-claude");
  writeFileSync(fake, "#!/bin/sh\necho \"agent saw: $2\"\necho hello > HELLO.md\n"); chmodSync(fake, 0o755);
  const logs: string[] = [];
  const runner = localRunner({ root: path.join(tmp, "ws"), resolveSecret: (n) => (n === "GITHUB_TOKEN" ? "tok-secret" : undefined), checkRepo: (r) => (r === "owner/app" ? null : "not registered"),
    defaultBranch: () => "main", claudeBin: fake, remoteBase: `file://${tmp}/remote` });
  const out = await runner({ runId: "run_t1", driver: "claude-code", with: { repo: "owner/app", prompt: "Create HELLO.md" }, secrets: {}, signal: new AbortController().signal, log: (c) => logs.push(c) });
  assert.equal(out.pushed, true);
  assert.equal(out.branch, "cobra/run_t1");
  assert.ok(existsSync(path.join(tmp, "ws/run_t1/HELLO.md")));
  assert.match(git(path.join(tmp, "remote/owner/app.git"), "branch"), /cobra\/run_t1/);
  assert.equal(git(path.join(tmp, "remote/owner/app.git"), "rev-parse", "main"), git(seed, "rev-parse", "HEAD"), "default branch untouched");
  const all = logs.join("");
  assert.match(all, /agent saw: Create HELLO.md/);
  assert.ok(!all.includes("tok-secret"));
  await assert.rejects(runner({ runId: "run_t2", driver: "claude-code", with: { repo: "evil/repo", prompt: "x" }, secrets: {}, signal: new AbortController().signal, log: () => {} }), /not registered/);
  // no token: scratch repo, log says why, nothing pushed
  const scratch = localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, claudeBin: fake });
  const l2: string[] = [];
  const o2 = await scratch({ runId: "run_t3", driver: "claude-code", with: { repo: "owner/app", prompt: "p" }, secrets: {}, signal: new AbortController().signal, log: (c) => l2.push(c) });
  assert.equal(o2.pushed, false);
  assert.match(l2.join(""), /GITHUB_TOKEN is not set/);
  // timeout
  const slow = path.join(tmp, "slow"); writeFileSync(slow, "#!/bin/sh\nsleep 5\n"); chmodSync(slow, 0o755);
  const t = localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, codexBin: slow });
  await assert.rejects(t({ runId: "run_t4", driver: "codex", with: { prompt: "p" }, secrets: {}, signal: new AbortController().signal, timeoutMs: 300, log: () => {} }), /exited/);
  assert.ok(readFileSync(path.join(tmp, "ws/run_t1/HELLO.md"), "utf8").includes("hello"));
});
