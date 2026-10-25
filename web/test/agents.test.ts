// Job 14: team agents (direct runs, workflow references, effective approval hash).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, checkTeamRepo } from "../lib/repos";
import { AgentError, createAgent, deleteAgent, getAgent, listAgents, updateAgent } from "../lib/agents";
import { approvalState, recordDecision } from "../lib/workflows/approvals";
import { builtinHandlers } from "../lib/workflows/handlers";
import { getRunDetail } from "../lib/workflows/runner";
import { findWorkflow, type Actor } from "../lib/workflows/store";
import { runAgent, saveWorkflow, startRun, workflowDetail, type RunDeps } from "../lib/workflows/service";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const a = mk("admin@a.com", "admin", "team-a"), lead = mk("lead@a.com", "team_lead", "team-a"), member = mk("member@a.com", "member", "team-a"), m2 = mk("m2@a.com", "member", "team-a");
  const b = mk("admin@b.com", "admin", "team-b");
  addTeamRepo(db, a, "vicgupta/factory-demo-app", "main");
  return { db, a, lead, member, m2, b };
}
const deps = (db: ReturnType<typeof openDb>, t: number): RunDeps => ({ handlers: builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, t, r) }), resolveSecret: () => undefined, redact: () => [] });
const is = (status: number) => (e: unknown) => e instanceof AgentError && e.status === status;
const wf = (name: string, steps: string) => `name: ${name}
version: 1
governance:
  owner: owner@a.com
  approvers: [{ role: admin }]
steps:
${steps}`;

test("agents: team scoping, any member creates, creator/lead/admin edit+delete, others 403", () => {
  const { db, a, lead, member, m2, b } = setup();
  const r = createAgent(db, member, { name: "reviewer", engine: "codex", prompt: "Review the code", defaultRepo: "vicgupta/factory-demo-app" });
  assert.equal(r.contentHash.length, 64);
  createAgent(db, m2, { name: "writer", engine: "claude-code", prompt: "Write docs" });
  assert.deepEqual(listAgents(db, a.tenantId).map((x) => x.name), ["reviewer", "writer"]);
  assert.deepEqual(listAgents(db, b.tenantId), [], "other teams never see them");
  assert.equal(getAgent(db, b.tenantId, "reviewer"), null);
  assert.throws(() => createAgent(db, member, { name: "reviewer", engine: "codex", prompt: "x" }), is(409));
  assert.throws(() => createAgent(db, member, { name: "Bad Name", engine: "codex", prompt: "x" }), is(400));
  assert.throws(() => createAgent(db, member, { name: "x", engine: "gpt", prompt: "x" }), is(400));
  assert.throws(() => createAgent(db, member, { name: "y", engine: "codex", prompt: "x", defaultRepo: "other/repo" }), is(400));
  createAgent(db, b, { name: "reviewer", engine: "codex", prompt: "team b's own" });
  // edit/delete permissions
  assert.throws(() => updateAgent(db, m2, "reviewer", { prompt: "nope" }), is(403));
  assert.throws(() => deleteAgent(db, m2, "reviewer"), is(403));
  assert.throws(() => updateAgent(db, b, "writer", { prompt: "x" }), is(404), "other team's admin can't reach it");
  const h0 = getAgent(db, a.tenantId, "reviewer")!.contentHash;
  assert.notEqual(updateAgent(db, member, "reviewer", { prompt: "Review v2" }).contentHash, h0, "creator edits; new version");
  updateAgent(db, lead, "reviewer", { defaultRepo: null });
  updateAgent(db, a, "writer", { engine: "codex" });
  deleteAgent(db, lead, "writer");
  deleteAgent(db, a, "reviewer");
  assert.deepEqual(listAgents(db, a.tenantId), []);
  assert.equal(listAgents(db, b.tenantId).length, 1);
});

test("agents: direct single run (no approval) logs agent, short hash and final prompt", async () => {
  const { db, member, b } = setup();
  const ag = createAgent(db, member, { name: "reviewer", engine: "codex", prompt: "Review the code", defaultRepo: "vicgupta/factory-demo-app" });
  const r = runAgent(db, member, "reviewer", { mode: "simulated", instructions: "Focus on tests" }, deps(db, member.tenantId));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await r.run!.done;
  const d = getRunDetail(db, r.run!.id)!;
  assert.equal(d.status, "succeeded");
  assert.deepEqual([d.workflow, d.engine, d.mode, d.repo, d.promptSource, d.branch], ["agent:reviewer", "codex", "simulated", "vicgupta/factory-demo-app", "agent", null]);
  assert.match(d.prompt!, /Review the code\n\nAdditional instructions:\nFocus on tests/);
  const out = d.events.find((e) => e.stepId === "agent" && e.status === "succeeded")!.output!;
  assert.match(out, new RegExp(`\\[agent\\] reviewer @ ${ag.contentHash.slice(0, 12)} \\(codex, default, simulated\\)`));
  assert.match(out, /Focus on tests/);
  assert.equal(runAgent(db, member, "reviewer", { repo: "other/x" }, deps(db, member.tenantId)).status, 400);
  assert.equal(runAgent(db, member, "reviewer", { mode: "fast" }, deps(db, member.tenantId)).status, 400);
  assert.equal(runAgent(db, b, "reviewer", {}, deps(db, b.tenantId)).status, 404, "other team can't run it");
});

test("agents in workflows: two agents chained, effective hash, re-approval after edit, unknown agent error", async () => {
  const { db, a, member } = setup();
  createAgent(db, member, { name: "writer", engine: "claude-code", prompt: "Write the change" });
  createAgent(db, member, { name: "reviewer", engine: "codex", prompt: "Review it" });
  const src = wf("pair", `  - id: write
    uses: agent
    with: { agent: writer, prompt: "Topic: docs" }
    outputs: { summary: "\${{ result.summary }}" }
  - id: review
    uses: agent
    needs: write
    with: { agent: reviewer, prompt: "Previous: \${{ steps.write.outputs.summary }}" }
`);
  const s = await saveWorkflow(db, a, { source: src });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  let w = findWorkflow(db, a.tenantId, "pair")!;
  assert.notEqual(w.hash, w.sourceHash, "effective hash includes agents");
  recordDecision(db, a, w, "approve");
  assert.equal(approvalState(db, a.tenantId, w).status, "approved");
  const r = startRun(db, member, "pair", { mode: "simulated" }, deps(db, a.tenantId));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await r.run!.done;
  const d = getRunDetail(db, r.run!.id)!;
  assert.equal(d.status, "succeeded");
  const log = (id: string) => d.events.find((e) => e.stepId === id && e.status === "succeeded")!.output!;
  assert.match(log("write"), /\[agent\] writer @ [0-9a-f]{12} \(claude-code, default, simulated\)\n\[prompt\]\nWrite the change\n\nAdditional instructions:\nTopic: docs/);
  assert.match(log("review"), /\[agent\] reviewer @ [0-9a-f]{12} \(codex/);
  assert.match(log("review"), /Previous: Simulated claude-code run/, "chained through needs + outputs");
  // editing an agent sends the workflow back to pending
  updateAgent(db, member, "reviewer", { prompt: "Review it carefully" });
  w = findWorkflow(db, a.tenantId, "pair")!;
  assert.equal(approvalState(db, a.tenantId, w).status, "pending");
  assert.equal(startRun(db, member, "pair", { mode: "simulated" }, deps(db, a.tenantId)).status, 409);
  recordDecision(db, a, w, "approve");
  assert.equal(startRun(db, member, "pair", { mode: "simulated" }, deps(db, a.tenantId)).status, 201);
  // unknown agent: validation error at run time, shown on the workflow page
  deleteAgent(db, member, "reviewer");
  const det = workflowDetail(db, a, "pair").body as { agentErrors: string[]; steps: Array<{ agent: string | null }> };
  assert.match(det.agentErrors[0], /unknown agent 'reviewer'/);
  assert.deepEqual(det.steps.map((x) => x.agent), ["writer", "reviewer"]);
  w = findWorkflow(db, a.tenantId, "pair")!;
  recordDecision(db, a, w, "approve");
  const bad = startRun(db, member, "pair", { mode: "simulated" }, deps(db, a.tenantId));
  assert.equal(bad.status, 400);
  assert.match((bad.body as { error: string }).error, /unknown agent 'reviewer'/);
  // schema: with.agent only on agent steps, not combined with driver
  const bad2 = await saveWorkflow(db, a, { source: wf("bad2", "  - id: x\n    uses: agent\n    with: { agent: writer, driver: codex }\n") });
  assert.equal(bad2.status, 400);
});

test("agents: prompt limit is 20000 characters (Job 18)", () => {
  const { db, member } = setup();
  assert.equal(createAgent(db, member, { name: "long", engine: "codex", prompt: "x".repeat(15000) }).prompt.length, 15000);
  createAgent(db, member, { name: "edge", engine: "codex", prompt: "x".repeat(20000) });
  assert.throws(() => createAgent(db, member, { name: "toolong", engine: "codex", prompt: "x".repeat(20001) }), is(400));
  assert.throws(() => updateAgent(db, member, "long", { prompt: "x".repeat(20001) }), is(400));
});
