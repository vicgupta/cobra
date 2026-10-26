import { addTeamRepo } from "../lib/repos";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openDb, type DB } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { STEP_AT } from "../lib/runs";
import { workflowJsonSchema } from "../lib/workflows/schema";
import { loadTemplates, loadWorkflows, parseWorkflow, topoOrder, workflowsDir, WorkflowError, type LoadedWorkflow } from "../lib/workflows/loader";
import { condition, interpolate } from "../lib/workflows/expr";
import { executeWorkflow, LOG_CAP, redact, WorkflowNotApprovedError, type Handlers } from "../lib/workflows/engine";
import { approvalState, canApprove, recordDecision, PermissionError } from "../lib/workflows/approvals";
import { github } from "../lib/workflows/handlers";
import { canViewRun, getRunDetail, startWorkflowRun } from "../lib/workflows/runner";
import { canEdit, listAll, saveTenantWorkflow, SaveError, seedTemplates, systemTemplates, templateCopySource, type Actor } from "../lib/workflows/store";
import { decide, listWorkflowsFor, parseStatusFilter, statusCounts, type StatusFilter, runDetailFor, saveWorkflow, startRun, syncWorkflow, templateCopy, workflowDetail, type RunDeps } from "../lib/workflows/service";
import { githubFiles, GitHubStorageError } from "../lib/workflows/github-files";

const DIR = workflowsDir();
const yaml = (steps: string, extra = "") => `name: t
version: 1
governance:
  owner: owner@x.com
  approvers: [{ role: admin }, lead@x.com]
${extra}steps:
${steps}`;
const errorsOf = (src: string) => { try { parseWorkflow(src, "t.yaml"); return []; } catch (e) { return (e as WorkflowError).errors; } };
const always = () => true;

// ---------- schema / loader ----------
test("schema: valid file parses; bad files give clear errors", () => {
  assert.deepEqual(errorsOf(yaml("  - id: a\n    uses: noop\n")), []);
  assert.match(errorsOf(yaml("  - id: a\n    uses: teleport\n")).join("\n"), /steps\[0\]\.uses/);
  assert.match(errorsOf(yaml("  - id: a\n    uses: shell\n")).join("\n"), /run/);
  assert.match(errorsOf(yaml("  - id: a\n    uses: github\n    with: { action: merge-pr }\n")).join("\n"), /GITHUB_TOKEN/);
  assert.match(errorsOf("name: t\nversion: 1\nsteps: []\n").join("\n"), /governance/);
  assert.match(errorsOf("name: [oops").join("\n"), /YAML|yaml|Flow/i);
  assert.match(errorsOf(yaml("  - id: a\n    uses: noop\n").replace("name: t", "name: other")).join("\n"), /file name/);
});

test("loader: cycles, unknown needs, unknown refs, non-ancestor refs", () => {
  assert.match(errorsOf(yaml("  - id: a\n    uses: noop\n    needs: b\n  - id: b\n    uses: noop\n    needs: a\n")).join("\n"), /dependency cycle: a -> b -> a|dependency cycle: b -> a -> b/);
  assert.match(errorsOf(yaml("  - id: a\n    uses: noop\n    needs: zz\n")).join("\n"), /zz/);
  assert.match(errorsOf(yaml("  - id: a\n    uses: noop\n    with: { x: '${{ inputs.nope }}' }\n")).join("\n"), /nope/);
  assert.match(errorsOf(yaml("  - id: a\n    uses: noop\n    with: { x: '${{ steps.b.outputs.k }}' }\n  - id: b\n    uses: noop\n")).join("\n"), /\bb\b/);
  assert.deepEqual(topoOrder({ steps: [{ id: "b", needs: ["a"] }, { id: "a", needs: [] }] as never }), ["a", "b"]);
});

test("built-ins and system templates all parse; JSON schema file is current", () => {
  const repo = loadWorkflows(DIR), tpl = loadTemplates();
  assert.deepEqual([...repo.errors, ...tpl.errors], []);
  assert.deepEqual(repo.workflows.map((w) => w.workflow.name).sort(), ["agent-run", "issue-to-merge-flow", "issue-to-pr", "test-run"]);
  assert.deepEqual(tpl.workflows.map((w) => w.workflow.name).sort(), ["cloud-software-factory", "issue-to-merge"]);
  assert.equal(tpl.workflows.find((w) => w.workflow.name === "issue-to-merge")!.workflow.steps.length, 3);
  assert.equal(tpl.workflows.find((w) => w.workflow.name === "cloud-software-factory")!.workflow.steps.length, 7);
  assert.ok(tpl.workflows.every((w) => w.workflow.system && w.workflow.template));
  const onDisk = JSON.parse(readFileSync(path.join(DIR, "workflow.schema.json"), "utf8"));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(workflowJsonSchema())));
});

test("test-run.yaml reproduces the old STEP_AT timeline", () => {
  const wf = loadWorkflows(DIR).workflows.find((w) => w.workflow.name === "test-run")!.workflow;
  let t = 0; const at: number[] = [];
  for (const s of wf.steps) { at.push(t); t += Number(s.with?.duration_ms ?? 0); }
  assert.deepEqual(at, [STEP_AT.queued, STEP_AT["signing-in"], STEP_AT.running, STEP_AT["pr-opened"]]);
});

test("expressions: interpolation keeps types; conditions", () => {
  const ctx = { inputs: { n: 3, s: "x" }, steps: { a: { outputs: { k: "v" }, status: "succeeded" } } };
  assert.equal(interpolate(ctx, "${{ inputs.n }}"), 3);
  assert.equal(interpolate(ctx, "n=${{ inputs.n }} ${{ steps.a.outputs.k }}"), "n=3 v");
  assert.equal(condition(ctx, "steps.a.status == 'succeeded' && inputs.s != 'y'"), true);
  assert.equal(condition(ctx, "inputs.s == 'y' || steps.a.status == 'failed'"), false);
});

// ---------- engine ----------
const parse = (src: string) => parseWorkflow(src, "t.yaml");
const echo: Handlers = { noop: async (c) => ({ ...c.with }), simulate: async (c) => ({ ...c.with }) };

test("engine: order, output passing, skip vs failure semantics, retries", async () => {
  const w = parse(yaml(`  - id: c
    uses: noop
    needs: [b]
    with: { got: '\${{ steps.b.outputs.v }}' }
    outputs: { got: '\${{ result.got }}' }
  - id: a
    uses: noop
    with: { v: 1 }
    outputs: { v: '\${{ result.v }}' }
  - id: b
    uses: noop
    needs: a
    with: { v: '\${{ steps.a.outputs.v }}' }
    outputs: { v: '\${{ result.v }}' }
  - id: skipme
    uses: noop
    if: "false"
  - id: after_skip
    uses: noop
    needs: skipme
  - id: flaky
    uses: simulate
    retries: 2
  - id: boom
    uses: shell
    run: exit 1
  - id: blocked
    uses: noop
    needs: boom
`));
  const order: string[] = []; let tries = 0;
  const r = await executeWorkflow(w, {
    runId: "r1", isApproved: always,
    handlers: { noop: async (c) => { order.push(c.step.id); return { ...c.with }; }, simulate: async () => { if (++tries < 3) throw new Error("flake"); return {}; }, shell: async () => { throw new Error("exit 1"); } },
  });
  assert.equal(r.status, "failed");
  assert.deepEqual(order.filter((x) => ["a", "b", "c"].includes(x)), ["a", "b", "c"]);
  assert.equal(r.steps.c.outputs.got, 1);
  assert.equal(r.steps.skipme.status, "skipped");
  assert.equal(r.steps.after_skip.status, "succeeded");
  assert.equal(r.steps.flaky.status, "succeeded"); assert.equal(r.steps.flaky.attempts, 3);
  assert.equal(r.steps.boom.status, "failed");
  assert.equal(r.steps.blocked.status, "skipped"); assert.equal(r.steps.blocked.skippedBy, "dependency");
});

test("engine refuses unapproved workflows; redaction and truncation", async () => {
  const w = parse(yaml("  - id: a\n    uses: noop\n"));
  await assert.rejects(executeWorkflow(w, { runId: "x", handlers: echo, isApproved: () => false }), WorkflowNotApprovedError);
  assert.equal(redact('tok=s3cr3t-value "s3cr3t-value"', ["s3cr3t-value"]), 'tok=[REDACTED] "[REDACTED]"');
  const big = parse(yaml("  - id: a\n    uses: noop\n"));
  const r = await executeWorkflow(big, { runId: "y", isApproved: always, handlers: { noop: async () => ({ stdout: "x".repeat(LOG_CAP + 50) }) } });
  assert.ok(r.steps.a.truncated); assert.match(r.steps.a.log!, /truncated/);
});

test("github handler (mocked fetch only) and repo allow-list", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const h = github(async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify({ number: 7, html_url: "u", merged: true, sha: "s" }), { status: 201 }); });
  const ctx = (w: Record<string, unknown>) => ({ runId: "r", step: { id: "g" } as never, with: w, secrets: { GITHUB_TOKEN: "ghp_test" }, signal: new AbortController().signal });
  const out = await h(ctx({ action: "create-issue", repo: "vicgupta/cobra-sandbox", title: "t" }));
  assert.equal(out.number, 7);
  assert.match(calls[0].url, /repos\/vicgupta\/cobra-sandbox\/issues$/);
  process.env.COBRA_GITHUB_ALLOWED_REPOS = "vicgupta/cobra-sandbox";
  try { await assert.rejects(h(ctx({ action: "create-issue", repo: "vicgupta/cobra", title: "t" })), /ALLOWED_REPOS/); }
  finally { delete process.env.COBRA_GITHUB_ALLOWED_REPOS; }
});

// ---------- DB: approvals, templates, tenant workflows, runs ----------
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant = "default") => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const admin = mk("vicgupta@gmail.com", "admin"), lead = mk("lead@x.com", "team_lead"), member = mk("member@x.com", "member"), owner = mk("owner@x.com", "member");
  const otherAdmin = mk("boss@other.com", "admin", "other");
  return { db, admin, lead, member, owner, otherAdmin };
}

test("approvals: who may approve, self-approval policy, hash invalidation", () => {
  const { db, admin, lead, member, owner } = setup();
  const w = parse(yaml("  - id: a\n    uses: noop\n"));
  assert.ok(canApprove(admin, w.workflow.governance));
  assert.ok(canApprove(lead, w.workflow.governance)); // listed by email
  assert.ok(!canApprove(member, w.workflow.governance));
  assert.throws(() => recordDecision(db, member, w, "approve"), PermissionError);
  assert.equal(approvalState(db, admin.tenantId, w).status, "pending");
  recordDecision(db, lead, w, "approve", "lgtm");
  assert.equal(approvalState(db, admin.tenantId, w).status, "approved");
  const changed = parse(yaml("  - id: a\n    uses: noop\n  - id: b\n    uses: noop\n"));
  assert.equal(approvalState(db, admin.tenantId, changed).status, "pending", "any YAML change resets approval");
  // owner-as-approver doesn't count unless admin (default policy)
  const own = parse(yaml("  - id: a\n    uses: noop\n").replace("lead@x.com", "owner@x.com"));
  recordDecision(db, owner, own, "approve");
  assert.equal(approvalState(db, owner.tenantId, own).status, "pending");
  assert.equal(approvalState(db, owner.tenantId, own, "always").status, "approved");
  recordDecision(db, admin, own, "reject", "no");
  assert.equal(approvalState(db, owner.tenantId, own).status, "rejected");
});

test("system templates: seeded by name+hash (idempotent), pre-approved, read-only; copies need approval", async () => {
  const { db, admin, member } = setup();
  assert.equal(seedTemplates(db).seeded, 2);
  assert.equal(seedTemplates(db).seeded, 0);
  const t = systemTemplates(db);
  assert.equal(t.length, 2);
  assert.throws(() => recordDecision(db, admin, t[0], "approve"), PermissionError);
  assert.equal(approvalState(db, admin.tenantId, t[0]).status, "approved");
  const copy = templateCopySource(t.find((x) => x.workflow.name === "issue-to-merge")!, member, "my-merge");
  const saved = await saveTenantWorkflow(db, member, copy, { templateName: "issue-to-merge" });
  assert.equal(saved.workflow.system, false); assert.equal(saved.workflow.template, false);
  assert.equal(saved.workflow.governance.owner, "member@x.com");
  assert.equal(approvalState(db, admin.tenantId, saved).status, "pending");
  assert.equal((db.prepare("SELECT template_name n FROM tenant_workflows").get() as { n: string }).n, "issue-to-merge");
});

test("tenant workflows: save validates, names can't shadow built-ins, edit rules, tenant isolation, tenant templates", async () => {
  const { db, admin, member, otherAdmin } = setup();
  seedTemplates(db);
  const src = yaml("  - id: a\n    uses: noop\n").replace("name: t", "name: mine");
  await assert.rejects(saveTenantWorkflow(db, member, "name: x\nsteps: ["), (e: SaveError) => e.status === 400 && e.errors.length > 0);
  await assert.rejects(saveTenantWorkflow(db, member, src.replace("name: mine", "name: test-run")), (e: SaveError) => e.status === 409);
  await assert.rejects(saveTenantWorkflow(db, member, src.replace("name: mine", "name: issue-to-merge")), (e: SaveError) => e.status === 409);
  await assert.rejects(saveTenantWorkflow(db, member, src.replace("version: 1", "version: 1\nsystem: true")), (e: SaveError) => e.status === 400);
  await saveTenantWorkflow(db, member, src);
  await assert.rejects(saveTenantWorkflow(db, member, src), (e: SaveError) => e.status === 409);
  // member is neither owner nor approver, but created it: the creator may edit their own workflow.
  assert.ok(canEdit(member, listAll(db, member.tenantId).find((l) => l.name === "mine")!.loaded!));
  await saveTenantWorkflow(db, member, src + "\n", { previousName: "mine" });
  await saveTenantWorkflow(db, admin, src.replace("version: 1", "version: 2"), { previousName: "mine" });
  assert.equal(listAll(db, otherAdmin.tenantId).some((l) => l.name === "mine"), false);
  // workspace template
  await saveTenantWorkflow(db, member, src.replace("name: mine", "name: my-tpl").replace("version: 1", "version: 1\ntemplate: true"));
  const tpl = listAll(db, member.tenantId).find((l) => l.name === "my-tpl")!.loaded!;
  assert.ok(tpl.workflow.template && !tpl.workflow.system);
  assert.equal(approvalState(db, admin.tenantId, tpl).status, "pending");
  assert.throws(() => recordDecision(db, admin, tpl, "approve"), PermissionError);
});

test("author of a change can't be the sole approver (unless admin)", async () => {
  const { db, lead } = setup();
  const src = yaml("  - id: a\n    uses: noop\n").replace("name: t", "name: leads");
  const w = await saveTenantWorkflow(db, lead, src); // lead is an approver (by email) but also the author
  recordDecision(db, lead, w, "approve");
  assert.equal(approvalState(db, lead.tenantId, listAll(db, lead.tenantId).find((l) => l.name === "leads")!.loaded!).status, "pending");
});

const deps = (handlers: Handlers = echo, secretMap: Record<string, string> = {}): RunDeps => ({ handlers, resolveSecret: (n) => secretMap[n], redact: () => Object.values(secretMap) });
const tenantWf = async (db: DB, by: Actor, steps: string, name = "flow") => saveTenantWorkflow(db, by, yaml(steps, "inputs:\n  who: { type: string, required: true }\n").replace("name: t", `name: ${name}`));

test("service: approve/reject/run/view enforce permissions; run log is recorded in order with redaction", async () => {
  const { db, admin, lead, member, owner, otherAdmin } = setup();
  seedTemplates(db);
  await tenantWf(db, owner, `  - id: hello
    uses: noop
    secrets: [API_KEY]
    with: { msg: 'hi \${{ inputs.who }}' }
  - id: fail
    uses: shell
    needs: hello
    run: "false"
  - id: never
    uses: noop
    needs: fail
`);
  assert.equal((await saveWorkflow(db, member, { source: "nope: [" })).status, 400);
  assert.equal(decide(db, member, "flow", { decision: "approve" }).status, 403);
  assert.equal(decide(db, otherAdmin, "flow", { decision: "approve" }).status, 404, "other tenants can't see it");
  assert.equal(startRun(db, admin, "flow", { inputs: { who: "vic" } }, deps()).status, 409, "unapproved");
  assert.equal(decide(db, lead, "flow", { decision: "approve", comment: "ok" }).status, 200);
  const detail = workflowDetail(db, lead, "flow").body as { approval: { status: string }; can: { run: boolean }; decisions: Array<{ comment: string }> };
  assert.equal(detail.approval.status, "approved"); assert.ok(detail.can.run); assert.equal(detail.decisions[0].comment, "ok");
  assert.equal((workflowDetail(db, member, "flow").body as { can: { run: boolean; edit: boolean } }).can.run, true, "any tenant member can run an approved workflow");
  assert.equal((workflowDetail(db, member, "flow").body as { can: { run: boolean; edit: boolean } }).can.edit, false, "editing rules unchanged");
  assert.equal(startRun(db, lead, "flow", { inputs: {} }, deps()).status, 400, "required input");
  const secret = "sk-very-secret-123";
  const handlers: Handlers = { noop: async (c) => ({ stdout: `msg=${c.with.msg} key=${c.secrets.API_KEY}` }), shell: async () => { throw new Error(`exit 1 (env had ${secret})`); } };
  const res = startRun(db, lead, "flow", { inputs: { who: "vic" } }, deps(handlers, { API_KEY: secret }));
  assert.equal(res.status, 201);
  await res.run!.done;
  const r = getRunDetail(db, res.run!.id)!;
  assert.equal(r.status, "failed");
  assert.deepEqual(r.events.map((e) => `${e.stepId}:${e.status}`), [
    "hello:pending", "fail:pending", "never:pending", "hello:running", "hello:succeeded", "fail:running", "fail:failed", "never:skipped",
  ]);
  const all = JSON.stringify(r);
  assert.ok(!all.includes(secret), "secret redacted everywhere");
  assert.match(r.events.find((e) => e.stepId === "hello" && e.status === "succeeded")!.output!, /msg=hi vic key=\[REDACTED\]/);
  assert.match(r.events.find((e) => e.status === "failed")!.output!, /exit 1/);
  // run log visibility
  assert.equal(runDetailFor(db, lead, r.id).status, 200, "runner");
  assert.equal(runDetailFor(db, admin, r.id).status, 200, "tenant admin");
  assert.equal(runDetailFor(db, member, r.id).status, 200, "member of the same tenant sees the run log");
  assert.equal(runDetailFor(db, owner, r.id).status, 200, "any same-tenant user");
  assert.equal(runDetailFor(db, otherAdmin, r.id).status, 404, "admin of another tenant");
  assert.ok(!canViewRun({ id: lead.id, role: "team_lead", tenantId: 999 }, r));
  assert.ok(!canViewRun({ id: member.id, role: "member", tenantId: 999 }, r), "member of another tenant");
  assert.ok(canViewRun({ id: 12345, role: "member", tenantId: r.tenantId }, r));
  // templates can't be run; template copy endpoint
  assert.equal(startRun(db, admin, "issue-to-merge", {}, deps()).status, 403);
  const copy = templateCopy(db, member, "cloud-software-factory").body as { source: string; templateName: string };
  assert.equal(copy.templateName, "cloud-software-factory"); assert.match(copy.source, /owner: member@x.com/); assert.doesNotMatch(copy.source, /system: true/);
  assert.ok((listWorkflowsFor(db, member).body as Array<{ name: string }>).some((w) => w.name === "cloud-software-factory"));
});

test("built-in test-run runs through the engine once approved (as the Test run page does)", async () => {
  const { db, admin } = setup();
  const wf = loadWorkflows(DIR).workflows.find((w) => w.workflow.name === "test-run")! as LoadedWorkflow;
  const fast: Handlers = { simulate: async (c) => ({ ...c.with }), noop: async (c) => ({ ...c.with }) };
  assert.throws(() => startWorkflowRun(db, { tenantId: admin.tenantId, userId: admin.id }, wf, { repo: "vicgupta/cobra-sandbox", issue: 1 }, { handlers: fast }), WorkflowNotApprovedError);
  recordDecision(db, admin, wf, "approve");
  const run = startWorkflowRun(db, { tenantId: admin.tenantId, userId: admin.id }, wf, { repo: "vicgupta/cobra-sandbox", issue: 1 }, { handlers: fast, idPrefix: "sim_" });
  const out = await run.done;
  assert.equal(out.status, "succeeded");
  const row = db.prepare("SELECT repo, issue, agent, simulated, status FROM runs WHERE id = ?").get(run.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { repo: "vicgupta/cobra-sandbox", issue: 1, agent: "claude-code", simulated: 1, status: "succeeded" });
});

test("one template, many instances: each its own workflow linked to template name + hash", async () => {
  const { db, admin, lead } = setup();
  seedTemplates(db);
  const t = systemTemplates(db).find((x) => x.workflow.name === "issue-to-merge")!;
  const c1 = templateCopy(db, admin, "issue-to-merge").body as { source: string; templateName: string };
  assert.equal((await saveWorkflow(db, admin, { source: c1.source, templateName: c1.templateName })).status, 201);
  const c2 = templateCopy(db, lead, "issue-to-merge").body as { source: string; templateName: string };
  assert.match(c2.source, /name: issue-to-merge-copy-2/, "next free name");
  assert.equal((await saveWorkflow(db, lead, { source: c2.source, templateName: c2.templateName })).status, 201);
  const d = workflowDetail(db, admin, "issue-to-merge").body as { instances: Array<{ name: string; templateHash: string; fromCurrentVersion: boolean }> };
  assert.deepEqual(d.instances.map((i) => i.name).sort(), ["issue-to-merge-copy", "issue-to-merge-copy-2"]);
  assert.ok(d.instances.every((i) => i.templateHash === t.hash && i.fromCurrentVersion));
  const i2 = workflowDetail(db, admin, "issue-to-merge-copy-2").body as { owner: string; approval: { status: string }; createdFrom: { name: string; hash: string } };
  assert.equal(i2.owner, "lead@x.com"); assert.equal(i2.approval.status, "pending");
  assert.deepEqual({ ...i2.createdFrom }, { name: "issue-to-merge", hash: t.hash });
  assert.equal(decide(db, admin, "issue-to-merge-copy", { decision: "approve" }).status, 200);
  assert.equal((workflowDetail(db, admin, "issue-to-merge-copy-2").body as { approval: { status: string } }).approval.status, "pending", "approvals are per instance");
  // workspace templates can be instantiated too
  await saveTenantWorkflow(db, admin, yaml("  - id: a\n    uses: noop\n").replace("name: t", "name: ws-tpl").replace("version: 1", "version: 1\ntemplate: true"));
  const c3 = templateCopy(db, admin, "ws-tpl").body as { source: string; templateName: string };
  assert.equal((await saveWorkflow(db, admin, { source: c3.source, templateName: c3.templateName })).status, 201);
  assert.equal((workflowDetail(db, admin, "ws-tpl").body as { instances: unknown[] }).instances.length, 1);
});

function fakeGitHub() {
  const files = new Map<string, { content: string; sha: string }>(); let n = 0; const puts: string[] = [];
  const key = (r: string, p: string) => `${r}:${p}`;
  return { files, puts, client: {
    async get(repo: string, path: string) { return files.get(key(repo, path)) ?? null; },
    async put(repo: string, path: string, content: string, o: { sha?: string }) {
      const cur = files.get(key(repo, path));
      if (cur && cur.sha !== o.sha) throw new GitHubStorageError("conflict");
      const sha = `sha${++n}`; files.set(key(repo, path), { content, sha }); puts.push(key(repo, path)); return { sha };
    },
  } };
}

test("storage: github (mocked client, vicgupta/cobra-sandbox only) create, edit, import, sync resets approval", async () => {
  const { db, admin, lead } = setup();
  const gh = fakeGitHub();
  const REPO = "vicgupta/cobra-sandbox";
  const src = yaml("  - id: a\n    uses: noop\n").replace("name: t", "name: gh-flow");
  const body = (extra: object) => ({ source: src, storage: "github", github: { repo: REPO, path: ".cobra/gh-flow.yaml" }, ...extra });
  assert.equal((await saveWorkflow(db, admin, body({}), { github: gh.client })).status, 400, "not registered to the team");
  addTeamRepo(db, admin, REPO);
  addTeamRepo(db, admin, "vicgupta/cobra");
  assert.equal((await saveWorkflow(db, admin, body({}))).status, 500, "no client configured");
  assert.equal((await saveWorkflow(db, admin, { ...body({}), github: { repo: REPO, path: "../x.yaml" } }, { github: gh.client })).status, 400);
  process.env.COBRA_GITHUB_ALLOWED_REPOS = REPO;
  try { assert.equal((await saveWorkflow(db, admin, { ...body({}), github: { repo: "vicgupta/cobra", path: "a.yaml" } }, { github: gh.client })).status, 400); }
  finally { delete process.env.COBRA_GITHUB_ALLOWED_REPOS; }
  assert.equal((await saveWorkflow(db, admin, body({}), { github: gh.client })).status, 201);
  assert.equal(gh.files.get(`${REPO}:.cobra/gh-flow.yaml`)!.content, src);
  const d = workflowDetail(db, admin, "gh-flow").body as { storage: { kind: string; repo: string; sha: string } };
  assert.deepEqual([d.storage.kind, d.storage.repo, d.storage.sha], ["github", REPO, "sha1"]);
  // edit keeps storage and updates with the stored sha
  assert.equal((await saveWorkflow(db, admin, { source: src.replace("version: 1", "version: 2"), previousName: "gh-flow" }, { github: gh.client })).status, 200);
  assert.match(gh.files.get(`${REPO}:.cobra/gh-flow.yaml`)!.content, /version: 2/);
  // creating over an existing file is refused; import works
  assert.equal((await saveWorkflow(db, admin, { ...body({}), source: src.replace("gh-flow", "other") }, { github: gh.client })).status, 409);
  gh.files.set(`${REPO}:imp.yaml`, { content: src.replace("name: gh-flow", "name: imported"), sha: "x1" });
  assert.equal((await saveWorkflow(db, admin, { storage: "github", github: { repo: REPO, path: "imp.yaml" }, import: true }, { github: gh.client })).status, 201);
  // sync: approve, change on GitHub, sync -> new hash, pending again
  assert.equal(decide(db, lead, "imported", { decision: "approve" }).status, 200);
  assert.equal((await syncWorkflow(db, admin, "imported", gh.client)).body && (await syncWorkflow(db, admin, "imported", gh.client)).status, 200);
  gh.files.set(`${REPO}:imp.yaml`, { content: src.replace("name: gh-flow", "name: imported").replace("version: 1", "version: 9"), sha: "x2" });
  const s = (await syncWorkflow(db, admin, "imported", gh.client)).body as { changed: boolean };
  assert.ok(s.changed);
  assert.equal((workflowDetail(db, admin, "imported").body as { approval: { status: string } }).approval.status, "pending");
  assert.equal((await syncWorkflow(db, admin, "gh-flow-nope", gh.client)).status, 404);
});

test("github-files client: contents API calls (mocked fetch), no token -> clear error", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const f = (async (u: string, i?: RequestInit) => { calls.push([u, i]); return u.includes("missing") ? new Response("", { status: 404 }) : new Response(JSON.stringify({ content: Buffer.from("a: 1").toString("base64"), sha: "s1" }), { status: 200 }); }) as typeof fetch;
  const c = githubFiles("tok", f);
  assert.deepEqual(await c.get("vicgupta/cobra-sandbox", "w/x.yaml", "dev"), { content: "a: 1", sha: "s1" });
  assert.equal(calls[0][0], "https://api.github.com/repos/vicgupta/cobra-sandbox/contents/w/x.yaml?ref=dev");
  assert.equal(await c.get("vicgupta/cobra-sandbox", "missing.yaml"), null);
  await assert.rejects(githubFiles(undefined, f).get("vicgupta/cobra-sandbox", "x.yaml"), /GITHUB_TOKEN is not set/);
});

test("tenant run list is scoped by tenant and visible to members", async () => {
  const { openDb } = await import("../lib/db");
  const db = openDb(":memory:");
  const { createUser } = await import("../lib/auth/users");
  const a = createUser(db, { email: "a@x.io", tenant: "default", role: "admin", password: "pw-123456789" });
  const m = createUser(db, { email: "m@x.io", tenant: "default", role: "member", password: "pw-123456789" });
  const o = createUser(db, { email: "o@x.io", tenant: "acme", tenantName: "Acme", role: "member", password: "pw-123456789" });
  const t = (id: number) => (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
  db.prepare("INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at) VALUES ('sim_x', ?, ?, 'claude-code', 'r', 1, 't', 'p', 1, 1)").run(t(a), a);
  const list = (id: number) => db.prepare("SELECT id FROM runs WHERE tenant_id = ?").all(t(id)).length;
  assert.equal(list(m), 1); assert.equal(list(o), 0);
  const r = { createdBy: a, tenantId: t(a) };
  assert.ok(canViewRun({ id: m, role: "member", tenantId: t(m) }, r));
  assert.ok(!canViewRun({ id: o, role: "member", tenantId: t(o) }, r));
});

test("members create and edit their own workflows with no lead/admin step; run approval and others' workflows unchanged", async () => {
  const { db, admin, lead, member } = setup();
  // A member pastes YAML naming someone else as governance.owner (e.g. copied from a teammate's workflow).
  const src = yaml("  - id: a\n    uses: noop\n").replace("name: t", "name: mine").replace(/owner: .*/, `owner: ${admin.email}`);
  const created = await saveWorkflow(db, member, { source: src });
  assert.equal(created.status, 201, "members can create");
  const d = workflowDetail(db, member, "mine").body as { approval: { status: string }; can: { edit: boolean; run: boolean; approve: boolean } };
  assert.equal(d.can.edit, true, "the creator can edit their own workflow");
  assert.equal(d.approval.status, "pending"); assert.equal(d.can.run, false, "still needs run approval"); assert.equal(d.can.approve, false);
  const edited = await saveWorkflow(db, member, { source: src.replace("version: 1", "version: 2"), previousName: "mine" });
  assert.equal(edited.status, 200, "the creator saves an edit with no approval step");
  assert.equal(startRun(db, member, "mine", { inputs: {} }, deps()).status, 409, "unapproved edit still can't run");
  assert.equal(decide(db, member, "mine", { decision: "approve" }).status, 403, "creator can't self-approve");
  // Someone else's workflow: still not editable by a plain member.
  await saveWorkflow(db, lead, { source: src.replace("name: mine", "name: theirs") });
  assert.equal(canEdit(member, listAll(db, member.tenantId).find((l) => l.name === "theirs")!.loaded!), false);
  assert.equal((await saveWorkflow(db, member, { source: src.replace("name: mine", "name: theirs"), previousName: "theirs" })).status, 403);
});

test("status filter: ?status validated (unknown = all); same results for every role; rejected still can't run", async () => {
  const { db, admin, lead, member, owner } = setup();
  seedTemplates(db);
  await tenantWf(db, owner, "  - id: a\n    uses: noop\n", "ok-flow");
  await tenantWf(db, owner, "  - id: a\n    uses: noop\n", "bad-flow");
  await tenantWf(db, owner, "  - id: a\n    uses: noop\n", "wait-flow");
  assert.equal(decide(db, lead, "ok-flow", { decision: "approve" }).status, 200);
  assert.equal(decide(db, lead, "bad-flow", { decision: "reject", comment: "no" }).status, 200);
  for (const [v, want] of [["approved", "approved"], ["PENDING", "pending"], ["rejected", "rejected"], ["", "all"], ["bogus", "all"], [undefined, "all"], [["rejected", "x"], "rejected"]] as const)
    assert.equal(parseStatusFilter(v), want, String(v));
  const names = (u: Actor, status: StatusFilter) => (listWorkflowsFor(db, u, undefined, { status }).body as Array<{ name: string }>).map((w) => w.name).filter((n) => n.endsWith("-flow") && n !== "issue-to-merge-flow").sort();
  for (const u of [member, lead, admin]) {
    assert.deepEqual(names(u, "all"), ["bad-flow", "ok-flow", "wait-flow"], `${u.role} all includes rejected`);
    assert.deepEqual(names(u, "approved"), ["ok-flow"]);
    assert.deepEqual(names(u, "pending"), ["wait-flow"]);
    assert.deepEqual(names(u, "rejected"), ["bad-flow"]);
  }
  const rows = listWorkflowsFor(db, member).body as Array<{ approval?: { status: string } }>;
  const c = statusCounts(rows);
  assert.equal(c.all, rows.length); assert.equal(c.rejected, 1); assert.equal(c.approved + c.pending + c.rejected, rows.filter((r) => r.approval).length);
  assert.equal(workflowDetail(db, member, "bad-flow").status, 200, "members can open rejected workflows");
  assert.equal(startRun(db, member, "bad-flow", { inputs: { who: "x" } }, deps()).status, 409, "approval gate blocks rejected runs");
});
