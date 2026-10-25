import type { DB } from "../db";
import { hasAgentStep } from "./runner";
import { findWorkflow } from "./store";

export type CleanupItem = { id: string; workflow: string; headerEvents: number; clearedLegacy: boolean };

/**
 * One-off data fix: runs of workflows with no `uses: agent` step get engine, mode, prompt_source,
 * repo and branch cleared and their step_id='run' header events deleted. The legacy repo/agent/prompt
 * columns are only cleared when the workflow has no input of that name (test-run keeps its inputs).
 */
export function cleanupNonAgentRuns(db: DB, opts: { dryRun?: boolean; dir?: string } = {}): CleanupItem[] {
  const rows = db.prepare("SELECT id, tenant_id AS tenantId, workflow FROM runs WHERE workflow IS NOT NULL ORDER BY started_at").all() as Array<{ id: string; tenantId: number; workflow: string }>;
  const cache = new Map<string, ReturnType<typeof findWorkflow>>();
  const out: CleanupItem[] = [];
  for (const r of rows) {
    const key = `${r.tenantId}:${r.workflow}`;
    if (!cache.has(key)) cache.set(key, findWorkflow(db, r.tenantId, r.workflow, opts.dir));
    const w = cache.get(key);
    if (!w || hasAgentStep(w.workflow)) continue;
    const inputs = w.workflow.inputs ?? {};
    const keepLegacy = ["repo", "agent", "prompt"].some((k) => k in inputs);
    const headerEvents = (db.prepare("SELECT count(*) n FROM run_step_events WHERE run_id = ? AND step_id = 'run'").get(r.id) as { n: number }).n;
    const dirty = db.prepare("SELECT 1 FROM runs WHERE id = ? AND (engine IS NOT NULL OR mode IS NOT NULL OR prompt_source IS NOT NULL OR branch IS NOT NULL)").get(r.id);
    const legacy = !keepLegacy && db.prepare("SELECT 1 FROM runs WHERE id = ? AND (repo != '' OR agent != '' OR prompt != '')").get(r.id);
    if (!headerEvents && !dirty && !legacy) continue;
    out.push({ id: r.id, workflow: r.workflow, headerEvents, clearedLegacy: !!legacy });
    if (opts.dryRun) continue;
    db.prepare("UPDATE runs SET engine = NULL, mode = NULL, prompt_source = NULL, branch = NULL WHERE id = ?").run(r.id);
    // repo/agent/prompt columns are NOT NULL (legacy); '' reads back as null.
    if (legacy) db.prepare("UPDATE runs SET repo = '', agent = '', prompt = '' WHERE id = ?").run(r.id);
    db.prepare("DELETE FROM run_step_events WHERE run_id = ? AND step_id = 'run'").run(r.id);
  }
  return out;
}
