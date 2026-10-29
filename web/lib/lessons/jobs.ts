// Scheduled lesson jobs, driven by the existing notify scheduler tick (lib/notify-scheduler.ts):
// nightly capture sweep at 2 AM ET and the weekly sanitization pass Mondays at 3 AM ET. Each job is claimed
// once per team per period in lesson_jobs (restarts / several instances never double-run).
import type { DB } from "../db";
import { etParts } from "../cron";
import { nyClock } from "../notifications";
import { sweepTeam } from "./capture";
import { sanitizeTeam } from "./sanitize";

export const SWEEP_HOUR = 2, SANITIZE_HOUR = 3;
const claim = (db: DB, tenantId: number, kind: string, period: string, now: number) =>
  db.prepare("INSERT OR IGNORE INTO lesson_jobs (tenant_id, kind, period, at) VALUES (?, ?, ?, ?)").run(tenantId, kind, period, now).changes > 0;

export function maybeRunLessonJobs(db: DB, now: number, secrets: (tenantId: number) => string[] = () => []): Record<string, string> {
  const { date, hour } = nyClock(now);
  const out: Record<string, string> = {};
  const teams = db.prepare("SELECT id FROM tenants ORDER BY id").all() as Array<{ id: number }>;
  for (const { id } of teams) {
    if (hour >= SWEEP_HOUR && claim(db, id, "sweep", date, now)) { const r = sweepTeam(db, id, secrets(id), now); out[`sweep:${id}`] = `${r.created} new, ${r.updated} merged, ${r.stale} stale`; }
    if (etParts(now).dow === 1 && hour >= SANITIZE_HOUR && claim(db, id, "sanitize", date, now)) out[`sanitize:${id}`] = `${sanitizeTeam(db, id, now).flagged} flagged`;
  }
  return out;
}

/** Lessons waiting for review (pending + stale), all teams; for the admin digest count line. */
export const pendingLessonCount = (db: DB) => (db.prepare("SELECT count(*) n FROM lessons WHERE status IN ('pending','stale')").get() as { n: number }).n;
