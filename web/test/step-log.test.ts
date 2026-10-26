import { test } from "node:test";
import assert from "node:assert/strict";
import { capLog, collapseSteps, LiveLog, mergeLogs, type StepEvent } from "../lib/workflows/step-log";
import { executeWorkflow, LOG_CAP } from "../lib/workflows/engine";
import { parseWorkflow } from "../lib/workflows/loader";

test("capLog keeps head and tail with an omitted-count marker; cap is large", () => {
  assert.ok(LOG_CAP >= 200_000);
  const text = "H".repeat(100) + "m".repeat(1000) + "T".repeat(100);
  const c = capLog(text, 400);
  assert.ok(c.truncated); assert.equal(c.omitted, 800);
  assert.ok(c.text.startsWith("H".repeat(100))); assert.ok(c.text.endsWith("T".repeat(100)), "tail (where errors are) kept");
  assert.match(c.text, /\[truncated: 800 chars omitted\]/);
  assert.deepEqual(capLog("short", 400), { text: "short", truncated: false, omitted: 0 });
});

test("LiveLog never stops capturing: a huge header can't crowd out the latest output", () => {
  const l = new LiveLog(400);
  l.append("[agent] x\n[prompt]\n" + "p".repeat(5000));
  l.append("\nInsufficient account funds\n");
  assert.ok(l.truncated); assert.ok(l.text.startsWith("[agent] x"));
  assert.ok(l.text.endsWith("Insufficient account funds\n")); assert.match(l.text, /chars omitted/);
  assert.ok(l.text.length < 500);
});

test("mergeLogs keeps streamed output and appends the final log's new part", () => {
  const header = "[agent] a\n[prompt]\ndo it\n";
  assert.equal(mergeLogs(header + "stderr: boom\n", header + "[error]\nexit 1"), header + "stderr: boom\n[error]\nexit 1");
  assert.equal(mergeLogs(header + "[opencode] Insufficient funds\n", header + "[error]\nexit 1"), header + "[opencode] Insufficient funds\n[error]\nexit 1", "no partial-line overlap");
  assert.equal(mergeLogs(null, "x"), "x"); assert.equal(mergeLogs("x", null), "x"); assert.equal(mergeLogs("abc", "abc"), "abc");
});

test("collapseSteps: one entry per step, latest status, merged output (old runs too)", () => {
  const ev = (stepId: string, status: string, at: number, output: string | null = null): StepEvent => ({ stepId, status, attempt: status === "pending" ? 0 : 1, output, truncated: false, at });
  const v = collapseSteps([ev("run", "succeeded", 1, "engine: x"), ev("agent", "pending", 1), ev("agent", "running", 2, "[agent]\nlive: funds error"), ev("agent", "failed", 3, "[agent]\n[error]\nexit 1")]);
  assert.deepEqual(v.map((s) => s.stepId), ["run", "agent"]);
  const a = v[1];
  assert.equal(a.status, "failed"); assert.deepEqual(a.history, ["pending", "running", "failed"]);
  assert.equal(a.startedAt, 1); assert.equal(a.at, 3);
  assert.match(a.output!, /live: funds error/); assert.match(a.output!, /exit 1/);
  assert.equal(collapseSteps([ev("agent", "pending", 1), ev("agent", "running", 2)])[0].status, "running", "in-flight shows running only");
});

test("engine step log keeps the tail of long output", async () => {
  const wf = parseWorkflow("name: big\nversion: 1\ngovernance:\n  owner: o@x.com\n  approvers: [{ role: admin }]\nsteps:\n  - id: a\n    uses: noop\n", "big.yaml");
  const r = await executeWorkflow(wf, { runId: "z", isApproved: () => true, handlers: { noop: async () => ({ stdout: "x".repeat(LOG_CAP) + "THE-END" }) } });
  assert.ok(r.steps.a.truncated); assert.match(r.steps.a.log!, /THE-END/); assert.match(r.steps.a.log!, /chars omitted/);
});

test("runner: streamed output survives into the failed row; display collapses to one step", async () => {
  const { openDb } = await import("../lib/db");
  const { startWorkflowRun, getRunDetail } = await import("../lib/workflows/runner");
  const db = openDb(":memory:");
  const { createUser } = await import("../lib/auth/users");
  createUser(db, { email: "a@x.com", tenant: "default", role: "admin", password: "pw-1234567890" });
  const wf = parseWorkflow("name: s\nversion: 1\ngovernance:\n  owner: o@x.com\n  approvers: [{ role: admin }]\nsteps:\n  - id: agent\n    uses: noop\n", "s.yaml");
  const handlers = { noop: async (c: { log?: (s: string) => void }) => { c.log!("[prompt]\n" + "p".repeat(LOG_CAP)); c.log!("\nInsufficient account funds\n"); throw new Error("opencode exited with code 1"); } } as never;
  const run = startWorkflowRun(db, { tenantId: 1, userId: null, triggeredBy: "test" }, wf, {}, { handlers, preApproved: true } as never);
  await run.done;
  const d = getRunDetail(db, run.id)!;
  const failed = d.events.find((e) => e.status === "failed")!;
  assert.match(failed.output!, /Insufficient account funds/, "agent's own stderr kept");
  assert.match(failed.output!, /opencode exited with code 1/); assert.match(failed.output!, /\n\[error\]\n/); assert.match(failed.output!, /chars omitted/); assert.ok(failed.truncated);
  const steps = collapseSteps(d.events).filter((s) => s.stepId === "agent");
  assert.equal(steps.length, 1); assert.equal(steps[0].status, "failed"); assert.deepEqual(steps[0].history, ["pending", "running", "failed"]);
});
