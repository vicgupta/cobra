// Runs a task: its agent, with the task's skill (if set) instead of the agent's own prompt/skill,
// plus the task's run criteria (mode, repo, extra instructions). Manual runs record the user;
// scheduled runs record triggered_by "task <name> (schedule)".
import type { DB } from "./db";
import { getTask, setTaskLastRun, type Task } from "./tasks";
import { runTeamAgent, scheduleActor } from "./agent-run";
import type { Res, RunDeps } from "./workflows/service";
import type { Actor } from "./workflows/store";

export const scheduleLabel = (t: Pick<Task, "name">) => `task ${t.name} (schedule)`;

export function runTask(db: DB, user: Actor | null, tenantId: number, id: number, deps: RunDeps, o: { scheduled?: boolean; textDir?: string; mode?: unknown } = {}): Res {
  const t = getTask(db, tenantId, id);
  if (!t) return { status: 404, body: { error: "task not found" } };
  const mode = o.mode === undefined ? t.mode : o.mode;
  const actor = o.scheduled || !user ? scheduleActor(tenantId) : user;
  const r = runTeamAgent(db, actor, t.agent, { mode, repo: t.repo ?? undefined, instructions: t.instructions ?? undefined }, deps,
    { scheduled: !!o.scheduled, skillRef: t.skillRef, triggeredBy: o.scheduled ? scheduleLabel(t) : undefined, task: t.name, textDir: o.textDir });
  const runId = (r.body as { id?: unknown } | null)?.id;
  if (r.status < 300 && typeof runId === "string") setTaskLastRun(db, tenantId, t.id, runId);
  return r.status < 300 ? { ...r, body: { ...(r.body as object), task: t.name } } : r;
}
