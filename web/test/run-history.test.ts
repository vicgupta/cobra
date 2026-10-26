import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { migrate, openDb, type DB } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { loadWorkflows, workflowsDir } from "../lib/workflows/loader";
import { recordDecision } from "../lib/workflows/approvals";
import { startWorkflowRun } from "../lib/workflows/runner";
import type { Actor } from "../lib/workflows/store";
import { failureReason, normalizeStatus, parseHistoryFilter, parsePage, workflowRunHistory, type HistoryPage } from "../lib/workflows/run-history";

const DIR = workflowsDir();
// Legacy built-in test-run (retired from workflows/); kept as a simulated fixture.
const FIX = path.join(import.meta.dirname, "fixtures", "workflows");
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant = "default") => {
    const id = createUser(db, { email, tenant, tenantName: tenant === "default" ? undefined : `Team ${tenant}`, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const admin = mk("vicgupta@gmail.com", "admin"), lead = mk("lead@x.com", "team_lead"), member = mk("member@x.com", "member");
  const bMember = mk("bee@other.com", "member", "other"), bLead = mk("leadb@other.com", "team_lead", "other");
  return { db, admin, lead, member, bMember, bLead };
}
let seq = 0;
function addRun(db: DB, o: { tenantId: number; by: Actor | null; workflow: string; at: number; status?: string | null; ended?: number | null; error?: string | null; mode?: string | null; engine?: string | null; branch?: string }) {
  const id = `run_t${++seq}`;
  db.prepare(`INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at, workflow, status, ended_at, error, mode, engine, branch, triggered_by)
    VALUES (?, ?, ?, '', '', 0, 't', '', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, o.tenantId, o.by?.id ?? null, o.at, o.workflow, o.status === undefined ? "succeeded" : o.status, o.ended ?? null, o.error ?? null, o.mode ?? null, o.engine ?? null, o.branch ?? null, o.by ? o.by.email : "system");
  return id;
}
const page = (r: { status: number; body: unknown }) => { assert.equal(r.status, 200); return r.body as HistoryPage; };

test("run history: newest first, every field, duration, failure reason, no cobra/ branches, redaction", () => {
  const { db, member, lead } = setup();
  const a = addRun(db, { tenantId: member.tenantId, by: member, workflow: "test-run", at: 1000, ended: 4000, mode: "simulated", engine: "claude-code" });
  const b = addRun(db, { tenantId: member.tenantId, by: lead, workflow: "test-run", at: 3000, status: "failed", ended: 3500, error: "step(s) failed: agent\npush to cobra/run_abc failed using tok-SECRET-1234", mode: "real", engine: "codex", branch: "cobra/run_abc" });
  const c = addRun(db, { tenantId: member.tenantId, by: null, workflow: "test-run", at: 2000, status: "running" });
  addRun(db, { tenantId: member.tenantId, by: member, workflow: "other-wf", at: 5000 });
  const h = page(workflowRunHistory(db, member, "test-run", { secrets: ["tok-SECRET-1234"], dir: FIX }));
  assert.deepEqual(h.runs.map((r) => r.id), [b, c, a]);
  assert.equal(h.scope, "team");
  const [rb, rc, ra] = h.runs;
  assert.equal(rb.triggeredBy, "lead@x.com"); assert.equal(rc.triggeredBy, "system"); assert.equal(ra.triggeredBy, "member@x.com");
  assert.equal(ra.durationMs, 3000); assert.equal(rc.durationMs, null); assert.equal(rc.status, "running");
  assert.equal(rb.status, "failed"); assert.equal(rb.mode, "real"); assert.equal(rb.engine, "codex");
  assert.equal(rb.reason, "step(s) failed: agent");
  assert.ok(!JSON.stringify(h).includes("cobra/run_abc"), "no cobra/<run-id> branch names");
  assert.ok(!JSON.stringify(h).includes("tok-SECRET"), "no secrets");
  assert.ok(h.runs.every((r) => r.canOpen && r.team === undefined));
  assert.equal(failureReason("x cobra/run_1 y tok-SECRET-1234", ["tok-SECRET-1234"]), "x cobra/[hidden] y [REDACTED]");
  assert.equal(normalizeStatus("cancelled"), "cancelled"); assert.equal(normalizeStatus(null), "unknown");
});

test("run history: members and leads see only their team's runs; another team's workflow is 404", () => {
  const { db, member, lead, bMember, bLead } = setup();
  const mine = addRun(db, { tenantId: member.tenantId, by: member, workflow: "test-run", at: 1 });
  const theirs = addRun(db, { tenantId: bMember.tenantId, by: bMember, workflow: "test-run", at: 2 });
  addRun(db, { tenantId: bMember.tenantId, by: bMember, workflow: "only-b", at: 3 });
  for (const u of [member, lead]) {
    const h = page(workflowRunHistory(db, u, "test-run", { dir: FIX }));
    assert.deepEqual(h.runs.map((r) => r.id), [mine]);
    assert.equal(workflowRunHistory(db, u, "only-b", { dir: DIR }).status, 404);
  }
  for (const u of [bMember, bLead]) assert.deepEqual(page(workflowRunHistory(db, u, "test-run", { dir: FIX })).runs.map((r) => r.id), [theirs]);
  assert.equal(workflowRunHistory(db, member, "no-such-workflow", { dir: DIR }).status, 404);
});

test("run history: system admin sees every team's runs with a team column", () => {
  const { db, admin, member, bMember } = setup();
  const mine = addRun(db, { tenantId: member.tenantId, by: member, workflow: "test-run", at: 1 });
  const theirs = addRun(db, { tenantId: bMember.tenantId, by: bMember, workflow: "test-run", at: 2 });
  const onlyB = addRun(db, { tenantId: bMember.tenantId, by: bMember, workflow: "only-b", at: 3 });
  const h = page(workflowRunHistory(db, admin, "test-run", { dir: FIX }));
  assert.equal(h.scope, "all-teams");
  assert.deepEqual(h.runs.map((r) => [r.id, r.team]), [[theirs, "Team other"], [mine, "Vic"]]);
  // Run detail stays tenant-scoped, so other teams' runs are listed but not linked.
  assert.deepEqual(h.runs.map((r) => r.canOpen), [false, true]);
  assert.deepEqual(page(workflowRunHistory(db, admin, "only-b", { dir: DIR })).runs.map((r) => r.id), [onlyB]);
});

test("run history: status filter and paging", () => {
  const { db, member } = setup();
  for (let i = 0; i < 30; i++) addRun(db, { tenantId: member.tenantId, by: member, workflow: "test-run", at: 100 + i, status: i % 3 === 0 ? "failed" : i % 3 === 1 ? "succeeded" : "running" });
  addRun(db, { tenantId: member.tenantId, by: member, workflow: "test-run", at: 99, status: "cancelled" });
  const all = page(workflowRunHistory(db, member, "test-run", { dir: FIX }));
  assert.deepEqual(all.counts, { all: 31, passed: 10, failed: 11, running: 10 });
  assert.equal(all.runs.length, 25); assert.equal(all.pages, 2); assert.equal(all.runs[0].startedAt, 129);
  const p2 = page(workflowRunHistory(db, member, "test-run", { page: 2, dir: FIX }));
  assert.equal(p2.runs.length, 6); assert.equal(p2.runs.at(-1)?.status, "cancelled");
  assert.ok(!p2.runs.some((r) => all.runs.some((x) => x.id === r.id)), "pages don't overlap");
  assert.equal(page(workflowRunHistory(db, member, "test-run", { page: 99, dir: FIX })).page, 2);
  const failed = page(workflowRunHistory(db, member, "test-run", { filter: "failed", dir: FIX }));
  assert.ok(failed.runs.every((r) => r.status === "failed" || r.status === "cancelled")); assert.equal(failed.total, 11);
  assert.ok(page(workflowRunHistory(db, member, "test-run", { filter: "passed", dir: FIX })).runs.every((r) => r.status === "succeeded"));
  assert.ok(page(workflowRunHistory(db, member, "test-run", { filter: "running", dir: FIX })).runs.every((r) => r.status === "running"));
  assert.equal(parseHistoryFilter("FAILED"), "failed"); assert.equal(parseHistoryFilter("bogus"), "all"); assert.equal(parseHistoryFilter(["passed"]), "passed");
  assert.equal(parsePage("0"), 1); assert.equal(parsePage("x"), 1); assert.equal(parsePage("3"), 3);
});

test("migration 16 backfills triggered_by from created_by, 'unknown' when not known; new runs record the user", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, 15);
  const uid = createUser(db, { email: "m@x.com", tenant: "default", role: "member", password: "pw-1234567890" });
  const ins = db.prepare("INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, started_at, workflow) VALUES (?, 1, ?, '', '', 0, 't', 1, 'test-run')");
  ins.run("r_user", uid); ins.run("r_null", null);
  migrate(db);
  const tb = (id: string) => (db.prepare("SELECT triggered_by t FROM runs WHERE id = ?").get(id) as { t: string }).t;
  assert.equal(tb("r_user"), "m@x.com"); assert.equal(tb("r_null"), "unknown");
  // A real start through the runner stores the starter's email.
  const wf = loadWorkflows(FIX).workflows.find((w) => w.workflow.name === "test-run")!;
  const admin = createUser(db, { email: "vicgupta@gmail.com", tenant: "default", role: "admin", password: "pw-1234567890" });
  recordDecision(db, { id: admin, email: "vicgupta@gmail.com", role: "admin", tenantId: 1 }, wf, "approve");
  const fast = { simulate: async () => ({}), noop: async () => ({}) } as never;
  const run = startWorkflowRun(db, { tenantId: 1, userId: uid }, wf, { repo: "a/b", issue: 1 }, { handlers: fast });
  await run.done;
  assert.equal(tb(run.id), "m@x.com");
  const sys = startWorkflowRun(db, { tenantId: 1, userId: null, triggeredBy: "schedule" }, wf, { repo: "a/b", issue: 1 }, { handlers: fast });
  await sys.done;
  assert.equal(tb(sys.id), "schedule");
});
