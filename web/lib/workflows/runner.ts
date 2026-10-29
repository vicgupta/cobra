// Starts a workflow as a row in the runs table and executes it in the background,
// recording overall status/outputs on the run and every step status transition
// (with redacted, capped output) in run_step_events.
import type { DB } from "../db";
import { approvalState, approvedChecker } from "./approvals";
import { executeWorkflow, LOG_CAP, redact as redactText, InputError, resolveInputs, WorkflowNotApprovedError, type EngineEvent, type ExecuteOptions, type RunResult, type StepState } from "./engine";
import type { LoadedWorkflow } from "./loader";
import { capLog, LiveLog, mergeLogs } from "./step-log";
import type { Engine } from "../engines";
import { captureForRun } from "../lessons/capture";
import { injectedFor } from "../lessons/inject";

/** True when the workflow has at least one `uses: agent` step; only those runs carry engine/mode/repo/prompt/branch. */
/** Agent steps, plus github pr_from_issue (it runs an agent): these get the engine/repo/mode run fields. */
export function hasAgentStep(workflow: { steps: ReadonlyArray<{ uses: string; with?: Record<string, unknown> }> }): boolean {
  return workflow.steps.some((s) => s.uses === "agent" || (s.uses === "github" && s.with?.action === "pr_from_issue"));
}

export type RunMeta = { engine: Engine; prompt: string; promptSource: "workflow" | "custom" | "none" | "agent"; mode: "simulated" | "real"; repo?: string; branch?: string };
export type StartedRun = { id: string; startedAt: number; inputs: Record<string, string | number | boolean>; done: Promise<RunResult> };

export function startWorkflowRun(
  db: DB,
  /** triggeredBy: a trigger label for runs not started by a user (default: the user's email, else "system"). */
  who: { tenantId: number; userId: number | null; triggeredBy?: string },
  loaded: LoadedWorkflow,
  rawInputs: Record<string, unknown>,
  opts: Pick<ExecuteOptions, "handlers" | "resolveSecret" | "redact"> & { idPrefix?: string; now?: number; meta?: RunMeta; inputs?: Record<string, string | number | boolean>;
    /** Direct team-agent runs: no workflow approval (the agent itself is the unit; see service.runAgent). */
    preApproved?: boolean },
): StartedRun {
  const { workflow: wf, hash } = loaded;
  if (!opts.preApproved && approvalState(db, who.tenantId, loaded).status !== "approved") throw new WorkflowNotApprovedError(wf.name, hash);
  if (loaded.agentErrors?.length) throw new InputError(loaded.agentErrors);
  const inputs = opts.inputs ?? resolveInputs(wf, rawInputs);
  // Only agent workflows carry engine/mode/repo/prompt, a branch and the "run" header event.
  const meta = opts.meta && hasAgentStep(wf) ? { ...opts.meta } : undefined;
  const startedAt = opts.now ?? Date.now();
  const id = `${opts.idPrefix ?? "run_"}${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // One agent step pushes to cobra/<run-id>; several push to cobra/<run-id>-<step-id> each (shown in their logs).
  if (meta?.mode === "real" && !meta.branch && wf.steps.filter((s) => s.uses === "agent").length === 1) meta.branch = `cobra/${id}`;
  // Legacy columns (agent/repo/issue/title/prompt) are filled from same-named inputs when present.
  const issue = Number(inputs.issue ?? 0);
  db.prepare(`INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at, workflow, workflow_hash, status, engine, prompt_source, mode, branch, triggered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, coalesce(?, (SELECT email FROM users WHERE id = ?), 'system'))`).run(
    id, who.tenantId, who.userId, String(meta?.engine ?? inputs.agent ?? ""), String(meta?.repo ?? inputs.repo ?? ""), Number.isFinite(issue) ? issue : 0,
    String(inputs.title ?? "") || (issue ? `Issue #${issue}` : wf.name), String(meta?.prompt ?? inputs.prompt ?? ""),
    meta?.mode === "real" ? 0 : meta?.mode === "simulated" || wf.steps.every((s) => s.uses === "simulate" || s.uses === "noop") ? 1 : 0, startedAt, wf.name, hash,
    meta?.engine ?? null, meta?.promptSource ?? null, meta?.mode ?? null, meta?.branch ?? null, who.triggeredBy ?? null, who.userId,
  );
  const redactList = opts.redact ?? [];
  const update = db.prepare("UPDATE runs SET status = ?, steps_json = ?, outputs_json = ?, error = ?, ended_at = ? WHERE id = ?");
  const logEvent = db.prepare("INSERT INTO run_step_events (run_id, tenant_id, step_id, status, attempt, output, truncated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const strip = (s: Record<string, StepState>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, log: undefined }]));
  let pendingLogged = false;
  // Live output: streamed into the step's current "running" row while it runs (head + rolling tail, so
  // a long agent prompt header can't crowd out the agent's own output), then merged into the terminal row.
  const live = new Map<string, { row: number | bigint; log: LiveLog }>();
  const appendLive = db.prepare("UPDATE run_step_events SET output = ?, truncated = ? WHERE id = ?");
  const onEvent = (e: EngineEvent) => {
    const now = Date.now();
    if (e.type === "log") {
      const l = live.get(e.id);
      if (!l) return;
      l.log.append(e.chunk);
      appendLive.run(redactText(l.log.text, redactList), l.log.truncated ? 1 : 0, l.row);
      return;
    }
    if (e.type === "step") {
      const terminal = e.state.status !== "running";
      if (!terminal) {
        if (live.has(e.id)) return; // already running (e.g. a retry): keep streaming into the same row
        const r = logEvent.run(id, who.tenantId, e.id, e.state.status, e.state.attempts, null, 0, now);
        live.set(e.id, { row: r.lastInsertRowid, log: new LiveLog(LOG_CAP) });
        return;
      }
      const l = live.get(e.id);
      // The final log (header + result/error) alone drops what the agent printed (e.g. the provider's error); keep both.
      const merged = l && l.log.text ? capLog(mergeLogs(l.log.text, e.state.log ?? null) ?? "", LOG_CAP) : null;
      const output = merged ? redactText(merged.text, redactList) : (e.state.log ?? null);
      const truncated = merged ? merged.truncated || l!.log.truncated || !!e.state.truncated : !!e.state.truncated;
      logEvent.run(id, who.tenantId, e.id, e.state.status, e.state.attempts, output, truncated ? 1 : 0, now);
      live.delete(e.id);
      return;
    }
    if (!pendingLogged) {
      pendingLogged = true;
      if (meta) logEvent.run(id, who.tenantId, "run", "succeeded", 0, redactText(
        `engine: ${meta.engine}\nmode: ${meta.mode}\nrepo: ${meta.repo || "(none)"}${meta.branch ? `\nbranch: ${meta.branch}` : ""}\nprompt (${meta.promptSource}):\n${meta.prompt || "(empty)"}`, redactList), 0, now);
      for (const s of wf.steps) logEvent.run(id, who.tenantId, s.id, "pending", 0, null, 0, now);
    }
    update.run(e.status, JSON.stringify(strip(e.steps)), e.outputs ? JSON.stringify(e.outputs) : null, e.error ?? null, e.status === "running" ? null : now, id);
  };
  const done = executeWorkflow(loaded, { runId: id, inputs, handlers: opts.handlers, resolveSecret: opts.resolveSecret, redact: opts.redact, run: meta ? { engine: meta.engine, prompt: meta.prompt, prompt_source: meta.promptSource, repo: meta.repo ?? "", mode: meta.mode, branch: meta.branch ?? "" } : undefined, isApproved: opts.preApproved ? () => true : approvedChecker(db, who.tenantId, loaded), agents: loaded.agents, onEvent })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      update.run("failed", null, null, error, Date.now(), id);
      return { status: "failed", steps: {}, outputs: {}, error } as RunResult;
    });
  // Lesson capture once the run finishes (never fails the run).
  void done.then(() => { try { captureForRun(db, id, redactList); } catch (e) { console.error("[cobra] lesson capture:", e instanceof Error ? e.message : e); } });
  return { id, startedAt, inputs, done };
}

export type RunEvent = { stepId: string; status: string; attempt: number; output: string | null; truncated: boolean; at: number };
export type RunDetail = {
  id: string; workflow: string | null; workflowHash: string | null; status: string | null; error: string | null;
  startedAt: number; endedAt: number | null; createdBy: number | null; tenantId: number; outputs: Record<string, unknown> | null; events: RunEvent[];
  engine: string | null; promptSource: string | null; prompt: string | null; mode: string | null; repo: string | null; branch: string | null;
  /** Team lessons prepended to this run (same team only). */ injectedLessons: Array<{ id: number; title: string; status: string }>;
};

export function getRunDetail(db: DB, id: string): RunDetail | null {
  const r = db.prepare("SELECT id, tenant_id, created_by, workflow, workflow_hash, status, error, started_at, ended_at, outputs_json, engine, prompt_source, prompt, mode, repo, branch, agent FROM runs WHERE id = ?").get(id) as
    { engine: string | null; prompt_source: string | null; prompt: string | null; mode: string | null; repo: string | null; branch: string | null; agent: string | null; id: string; tenant_id: number; created_by: number | null; workflow: string | null; workflow_hash: string | null; status: string | null; error: string | null; started_at: number; ended_at: number | null; outputs_json: string | null } | undefined;
  if (!r) return null;
  const events = (db.prepare("SELECT step_id AS stepId, status, attempt, output, truncated, at FROM run_step_events WHERE run_id = ? ORDER BY id").all(id) as Array<Omit<RunEvent, "truncated"> & { truncated: number }>)
    .map((e) => ({ ...e, truncated: !!e.truncated }));
  return { id: r.id, workflow: r.workflow, workflowHash: r.workflow_hash, status: r.status, error: r.error, startedAt: r.started_at, endedAt: r.ended_at, createdBy: r.created_by, tenantId: r.tenant_id, outputs: r.outputs_json ? JSON.parse(r.outputs_json) : null, events,
    engine: r.engine ?? (r.agent || null), promptSource: r.prompt_source, prompt: r.prompt || null, mode: r.mode, repo: r.repo || null, branch: r.branch, injectedLessons: injectedFor(db, r.tenant_id, r.id) };
}

/** Any user of the run's tenant. */
export function canViewRun(user: { id: number; role: string; tenantId: number }, run: Pick<RunDetail, "createdBy" | "tenantId">): boolean {
  // Any member of the run's own tenant may view it (read-only log); never across tenants.
  return run.tenantId === user.tenantId;
}

export function listWorkflowRuns(db: DB, tenantId: number, workflow: string, limit = 20) {
  return (db.prepare("SELECT id, status, started_at AS startedAt, ended_at AS endedAt, created_by AS createdBy, workflow_hash AS workflowHash FROM runs WHERE tenant_id = ? AND workflow = ? ORDER BY started_at DESC LIMIT ?")
    .all(tenantId, workflow, limit) as Array<{ id: string; status: string | null; startedAt: number; endedAt: number | null; createdBy: number | null; workflowHash: string }>).map((r) => ({ ...r }));
}
