// Cron for team agents: once a minute, every enabled agent whose cron matches the current minute
// (America/New_York) is claimed with a conditional UPDATE of cron_last_fire, so a restart or a second
// app instance on the same DB never fires the same minute twice. Missed minutes are not caught up.
import type { DB } from "./db";
import { cronMatches, minuteFloor, parseCron } from "./cron";

export type DueAgent = { id: number; tenantId: number; name: string; mode: "simulated" | "real"; minute: number };

/** Claims and returns the agents due this minute; `fire` is called once per claimed agent. */
export function tickAgentSchedules(db: DB, now: number, fire: (a: DueAgent) => void): DueAgent[] {
  const minute = minuteFloor(now);
  const rows = db.prepare("SELECT id, tenant_id AS tenantId, name, cron, cron_mode AS mode FROM team_agents WHERE cron_enabled = 1 AND cron IS NOT NULL AND deleted_at IS NULL").all() as Array<{ id: number; tenantId: number; name: string; cron: string; mode: string }>;
  const claim = db.prepare("UPDATE team_agents SET cron_last_fire = ? WHERE id = ? AND cron_enabled = 1 AND (cron_last_fire IS NULL OR cron_last_fire < ?)");
  const fired: DueAgent[] = [];
  for (const r of rows) {
    let due = false;
    try { due = cronMatches(parseCron(r.cron), minute); } catch { continue; }
    if (!due || Number(claim.run(minute, r.id, minute).changes) !== 1) continue;
    const a: DueAgent = { id: r.id, tenantId: r.tenantId, name: r.name, mode: r.mode === "real" ? "real" : "simulated", minute };
    fired.push(a);
    try { fire(a); } catch (e) { console.error(`[cobra] scheduled agent ${r.name}:`, e instanceof Error ? e.message : e); }
  }
  return fired;
}

export type DueTask = { id: number; tenantId: number; name: string; minute: number };

/** Same per-minute DB claim as agents, for enabled tasks (the one scheduling place in the UI). */
export function tickTaskSchedules(db: DB, now: number, fire: (t: DueTask) => void): DueTask[] {
  const minute = minuteFloor(now);
  const rows = db.prepare("SELECT id, tenant_id AS tenantId, name, cron FROM tasks WHERE enabled = 1 AND cron IS NOT NULL AND deleted_at IS NULL").all() as Array<{ id: number; tenantId: number; name: string; cron: string }>;
  const claim = db.prepare("UPDATE tasks SET last_fire = ? WHERE id = ? AND enabled = 1 AND deleted_at IS NULL AND (last_fire IS NULL OR last_fire < ?)");
  const fired: DueTask[] = [];
  for (const r of rows) {
    let due = false;
    try { due = cronMatches(parseCron(r.cron), minute); } catch { continue; }
    if (!due || Number(claim.run(minute, r.id, minute).changes) !== 1) continue;
    const t: DueTask = { id: r.id, tenantId: r.tenantId, name: r.name, minute };
    fired.push(t);
    try { fire(t); } catch (e) { console.error(`[cobra] scheduled task ${r.name}:`, e instanceof Error ? e.message : e); }
  }
  return fired;
}

const g = globalThis as { __cobraAgentTimer?: ReturnType<typeof setInterval>; __cobraAgentStarted?: boolean };

/** Started from instrumentation.ts (Node runtime, production). Disable with COBRA_AGENT_SCHEDULER=off. */
export function startAgentScheduler(): void {
  if (g.__cobraAgentStarted || process.env.COBRA_AGENT_SCHEDULER === "off") return;
  g.__cobraAgentStarted = true;
  const tick = async () => {
    try {
      const { getDb } = await import("./db");
      const { runDeps } = await import("./workflows/server");
      const { runTeamAgent, scheduleActor } = await import("./agent-run");
      const db = getDb();
      const { runTask } = await import("./task-run");
      tickTaskSchedules(db, Date.now(), (t) => {
        const r = runTask(db, null, t.tenantId, t.id, runDeps(t.tenantId), { scheduled: true });
        console.log(`[cobra] scheduled task ${t.name} (team ${t.tenantId}): ${r.status}${r.status >= 400 ? ` ${JSON.stringify(r.body).slice(0, 200)}` : ""}`);
      });
      // Agent-level cron (columns kept) is no longer offered in the UI; it still fires only if a row has it enabled.
      tickAgentSchedules(db, Date.now(), (a) => {
        const r = runTeamAgent(db, scheduleActor(a.tenantId), a.name, { mode: a.mode }, runDeps(a.tenantId), { scheduled: true });
        console.log(`[cobra] scheduled agent ${a.name} (team ${a.tenantId}, ${a.mode}): ${r.status}${r.status >= 400 ? ` ${JSON.stringify(r.body).slice(0, 200)}` : ""}`);
      });
    } catch (e) { console.error("[cobra] agent scheduler:", e instanceof Error ? e.message : e); }
  };
  // Align to just after each minute boundary.
  setTimeout(() => { void tick(); g.__cobraAgentTimer = setInterval(() => void tick(), 60_000); g.__cobraAgentTimer.unref?.(); }, 60_000 - (Date.now() % 60_000) + 2_000).unref?.();
}
