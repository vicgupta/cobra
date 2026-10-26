import "server-only";
import { getDb } from "./db";
import type { SimulatedRun } from "./runs";
import type { AgentId } from "./types";
import { runName, triggeredByLabel, type RunRow } from "./runs-table";

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
  type R = { id: string; title: string; workflow: string | null; status: string | null; started_at: number; ended_at: number | null; triggered_by: string | null; uname: string | null; uemail: string | null };
  const rows = getDb().prepare(`SELECT r.id, r.title, r.workflow, r.status, r.started_at, r.ended_at, r.triggered_by, u.name AS uname, u.email AS uemail
    FROM runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.tenant_id = ? ORDER BY r.started_at DESC LIMIT ?`).all(tenantId, limit) as R[];
  return rows.map((r) => {
    const { name, kind } = runName(r.workflow, r.title);
    const trig = r.uname || r.uemail ? triggeredByLabel(r.uname, r.uemail) : triggeredByLabel(null, r.triggered_by);
    return { id: r.id, name, kind, status: r.status ?? "unknown", startedAt: r.started_at, endedAt: r.ended_at, triggeredBy: trig };
  });
}
