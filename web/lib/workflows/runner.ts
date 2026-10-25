// Starts a workflow as a row in the runs table and executes it in the background,
// recording overall status/outputs on the run and every step status transition
// (with redacted, capped output) in run_step_events.
import type { DB } from "../db";
import { approvalState, approvedChecker } from "./approvals";
import { executeWorkflow, resolveInputs, WorkflowNotApprovedError, type EngineEvent, type ExecuteOptions, type RunResult, type StepState } from "./engine";
import type { LoadedWorkflow } from "./loader";

export type StartedRun = { id: string; startedAt: number; inputs: Record<string, string | number | boolean>; done: Promise<RunResult> };

export function startWorkflowRun(
  db: DB,
  who: { tenantId: number; userId: number | null },
  loaded: LoadedWorkflow,
  rawInputs: Record<string, unknown>,
  opts: Pick<ExecuteOptions, "handlers" | "resolveSecret" | "redact"> & { idPrefix?: string; now?: number },
): StartedRun {
  const { workflow: wf, hash } = loaded;
  if (approvalState(db, who.tenantId, loaded).status !== "approved") throw new WorkflowNotApprovedError(wf.name, hash);
  const inputs = resolveInputs(wf, rawInputs);
  const startedAt = opts.now ?? Date.now();
  const id = `${opts.idPrefix ?? "run_"}${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Legacy columns (agent/repo/issue/title/prompt) are filled from same-named inputs when present.
  const issue = Number(inputs.issue ?? 0);
  db.prepare(`INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at, workflow, workflow_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run(
    id, who.tenantId, who.userId, String(inputs.agent ?? ""), String(inputs.repo ?? ""), Number.isFinite(issue) ? issue : 0,
    String(inputs.title ?? "") || (issue ? `Issue #${issue}` : wf.name), String(inputs.prompt ?? ""),
    wf.steps.every((s) => s.uses === "simulate" || s.uses === "noop") ? 1 : 0, startedAt, wf.name, hash,
  );
  const update = db.prepare("UPDATE runs SET status = ?, steps_json = ?, outputs_json = ?, error = ?, ended_at = ? WHERE id = ?");
  const logEvent = db.prepare("INSERT INTO run_step_events (run_id, tenant_id, step_id, status, attempt, output, truncated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const strip = (s: Record<string, StepState>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, log: undefined }]));
  let pendingLogged = false;
  const onEvent = (e: EngineEvent) => {
    const now = Date.now();
    if (e.type === "step") {
      const terminal = e.state.status !== "running";
      logEvent.run(id, who.tenantId, e.id, e.state.status, e.state.attempts, terminal ? (e.state.log ?? null) : null, e.state.truncated ? 1 : 0, now);
      return;
    }
    if (!pendingLogged) {
      pendingLogged = true;
      for (const s of wf.steps) logEvent.run(id, who.tenantId, s.id, "pending", 0, null, 0, now);
    }
    update.run(e.status, JSON.stringify(strip(e.steps)), e.outputs ? JSON.stringify(e.outputs) : null, e.error ?? null, e.status === "running" ? null : now, id);
  };
  const done = executeWorkflow(loaded, { runId: id, inputs, handlers: opts.handlers, resolveSecret: opts.resolveSecret, redact: opts.redact, isApproved: approvedChecker(db, who.tenantId, loaded), onEvent })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      update.run("failed", null, null, error, Date.now(), id);
      return { status: "failed", steps: {}, outputs: {}, error } as RunResult;
    });
  return { id, startedAt, inputs, done };
}

export type RunEvent = { stepId: string; status: string; attempt: number; output: string | null; truncated: boolean; at: number };
export type RunDetail = {
  id: string; workflow: string | null; workflowHash: string | null; status: string | null; error: string | null;
  startedAt: number; endedAt: number | null; createdBy: number | null; tenantId: number; outputs: Record<string, unknown> | null; events: RunEvent[];
};

export function getRunDetail(db: DB, id: string): RunDetail | null {
  const r = db.prepare("SELECT id, tenant_id, created_by, workflow, workflow_hash, status, error, started_at, ended_at, outputs_json FROM runs WHERE id = ?").get(id) as
    { id: string; tenant_id: number; created_by: number | null; workflow: string | null; workflow_hash: string | null; status: string | null; error: string | null; started_at: number; ended_at: number | null; outputs_json: string | null } | undefined;
  if (!r) return null;
  const events = (db.prepare("SELECT step_id AS stepId, status, attempt, output, truncated, at FROM run_step_events WHERE run_id = ? ORDER BY id").all(id) as Array<Omit<RunEvent, "truncated"> & { truncated: number }>)
    .map((e) => ({ ...e, truncated: !!e.truncated }));
  return { id: r.id, workflow: r.workflow, workflowHash: r.workflow_hash, status: r.status, error: r.error, startedAt: r.started_at, endedAt: r.ended_at, createdBy: r.created_by, tenantId: r.tenant_id, outputs: r.outputs_json ? JSON.parse(r.outputs_json) : null, events };
}

/** Only the user who started the run, or an admin of the run's tenant. */
export function canViewRun(user: { id: number; role: string; tenantId: number }, run: Pick<RunDetail, "createdBy" | "tenantId">): boolean {
  if (run.tenantId !== user.tenantId) return false;
  return run.createdBy === user.id || user.role === "admin";
}

export function listWorkflowRuns(db: DB, tenantId: number, workflow: string, limit = 20) {
  return db.prepare("SELECT id, status, started_at AS startedAt, ended_at AS endedAt, created_by AS createdBy, workflow_hash AS workflowHash FROM runs WHERE tenant_id = ? AND workflow = ? ORDER BY started_at DESC LIMIT ?")
    .all(tenantId, workflow, limit) as Array<{ id: string; status: string | null; startedAt: number; endedAt: number | null; createdBy: number | null; workflowHash: string }>;
}
