import "server-only";
import { getDb } from "./db";
import type { SimulatedRun } from "./runs";
import type { AgentId } from "./types";
import { recentRunRows, type RunRow } from "./runs-table";

type Row = { id: string; agent: AgentId; repo: string; issue: number; title: string; prompt: string; started_at: number; workflow: string | null; status: string | null };
const toRun = (r: Row): SimulatedRun => ({ id: r.id, agent: r.agent, repo: r.repo, issue: r.issue, title: r.title, prompt: r.prompt, startedAt: r.started_at, simulated: true, workflow: r.workflow, status: r.status });

export function listRuns(tenantId: number, limit = 50): SimulatedRun[] {
  return (getDb().prepare("SELECT * FROM runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?").all(tenantId, limit) as Row[]).map(toRun);
}

export function insertRun(tenantId: number, userId: number, run: SimulatedRun): void {
  getDb().prepare("INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .run(run.id, tenantId, userId, run.agent, run.repo, run.issue, run.title, run.prompt, run.startedAt);
}

/** Runs plus the time they were read at, for computing steps and ages. */
export function listRunsWithTime(tenantId: number): { now: number; runs: SimulatedRun[] } {
  return { now: Date.now(), runs: listRuns(tenantId) };
}

/** Dashboard rows: name/kind from the run's workflow column, trigger = user's name, else email local-part, else null. */
export function listRecentRunRows(tenantId: number, limit = 50): RunRow[] {
  return recentRunRows(getDb(), tenantId, limit);
}
