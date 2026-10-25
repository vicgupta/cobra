// Starts a workflow as a row in the runs table and executes it in the background,
// recording status, per-step state and outputs as the engine reports them.
import type { DB } from "../db";
import { approvalState, approvedChecker } from "./approvals";
import { executeWorkflow, resolveInputs, WorkflowNotApprovedError, type EngineEvent, type ExecuteOptions, type RunResult } from "./engine";
import { getWorkflow, type LoadedWorkflow } from "./loader";

export type StartedRun = { id: string; startedAt: number; inputs: Record<string, string | number | boolean>; done: Promise<RunResult> };

export function startWorkflowRun(
  db: DB,
  who: { tenantId: number; userId: number | null },
  nameOrLoaded: string | LoadedWorkflow,
  rawInputs: Record<string, unknown>,
  opts: Pick<ExecuteOptions, "handlers" | "resolveSecret"> & { idPrefix?: string; now?: number },
): StartedRun {
  const loaded = typeof nameOrLoaded === "string" ? getWorkflow(nameOrLoaded) : nameOrLoaded;
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
  const onEvent = (e: EngineEvent) => {
    if (e.type !== "run") {
      db.prepare("UPDATE runs SET steps_json = ? WHERE id = ?").run(JSON.stringify(currentSteps(e)), id);
      return;
    }
    update.run(e.status, JSON.stringify(e.steps), e.outputs ? JSON.stringify(e.outputs) : null, e.error ?? null, e.status === "running" ? null : Date.now(), id);
  };
  let steps: Record<string, unknown> = {};
  const currentSteps = (e: Extract<EngineEvent, { type: "step" }>) => (steps = { ...steps, [e.id]: e.state });
  const done = executeWorkflow(loaded, { runId: id, inputs, handlers: opts.handlers, resolveSecret: opts.resolveSecret, isApproved: approvedChecker(db, who.tenantId, loaded), onEvent })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      update.run("failed", JSON.stringify(steps), null, error, Date.now(), id);
      return { status: "failed", steps: {}, outputs: {}, error } as RunResult;
    });
  return { id, startedAt, inputs, done };
}
