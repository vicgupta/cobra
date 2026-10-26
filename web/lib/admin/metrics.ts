// Cross-tenant, read-only metrics for the system admin dashboard. Pure functions of the DB.
import type { DatabaseSync } from "node:sqlite";
import { LIMITS } from "../auth/rate-limit";
import { hiddenUserIdsJson } from "../members";

// System admins (role admin or COBRA_ADMIN_EMAIL) are never displayed: they are excluded from user lists,
// sessions and every user count, and their email is masked (null) on runs. Display only; data unchanged.

type DB = DatabaseSync;
const H = 3600_000, DAY = 24 * H;
const plain = <T>(rows: unknown[]): T[] => rows.map((r) => ({ ...(r as object) }) as T);
const n = (db: DB, sql: string, ...a: Array<string | number>) => Number((db.prepare(sql).get(...a) as { c: number }).c);

export function overview(db: DB, now = Date.now(), adminEmail?: string) {
  const h = hiddenUserIdsJson(db, adminEmail);
  const byStatus = plain<{ status: string; c: number }>(db.prepare("SELECT coalesce(status, 'legacy') status, count(*) c FROM runs GROUP BY 1 ORDER BY 2 DESC").all());
  return {
    tenants: n(db, "SELECT count(*) c FROM tenants"),
    users: n(db, "SELECT count(*) c FROM users u WHERE u.id NOT IN (SELECT value FROM json_each(?))", h),
    usersByRole: plain<{ role: string; c: number }>(db.prepare("SELECT role, count(*) c FROM users u WHERE u.id NOT IN (SELECT value FROM json_each(?)) GROUP BY role ORDER BY role").all(h)),
    activeSessions: n(db, "SELECT count(*) c FROM sessions WHERE expires_at > ? AND user_id NOT IN (SELECT value FROM json_each(?))", now, h),
    activeUsers24h: n(db, "SELECT count(DISTINCT user_id) c FROM sessions WHERE coalesce(last_seen_at, created_at) > ? AND user_id NOT IN (SELECT value FROM json_each(?))", now - DAY, h),
    tenantWorkflows: n(db, "SELECT count(*) c FROM tenant_workflows WHERE source NOT LIKE '%template: true%'"),
    tenantTemplates: n(db, "SELECT count(*) c FROM tenant_workflows WHERE source LIKE '%template: true%'"),
    instances: n(db, "SELECT count(*) c FROM tenant_workflows WHERE template_name IS NOT NULL"),
    githubStored: n(db, "SELECT count(*) c FROM tenant_workflows WHERE storage = 'github'"),
    systemTemplates: n(db, "SELECT count(*) c FROM workflow_templates WHERE current = 1"),
    runs: n(db, "SELECT count(*) c FROM runs"),
    runs24h: n(db, "SELECT count(*) c FROM runs WHERE started_at > ?", now - DAY),
    runs7d: n(db, "SELECT count(*) c FROM runs WHERE started_at > ?", now - 7 * DAY),
    runsByStatus: byStatus,
    approvals: n(db, "SELECT count(*) c FROM workflow_approvals"),
    rateLimitedNow: n(db, "SELECT count(*) c FROM rate_limits WHERE expires_at > ?", now),
    pendingResets: n(db, "SELECT count(*) c FROM password_resets WHERE used_at IS NULL AND expires_at > ?", now),
    schemaVersion: Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
  };
}

export function tenants(db: DB, adminEmail?: string) {
  const h = hiddenUserIdsJson(db, adminEmail);
  return plain<{ id: number; name: string; slug: string; created_at: number; users: number; workflows: number; runs: number; last_run: number | null }>(db.prepare(`
    SELECT t.id, t.name, t.slug, t.created_at,
      (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.id NOT IN (SELECT value FROM json_each(?))) users,
      (SELECT count(*) FROM tenant_workflows w WHERE w.tenant_id = t.id) workflows,
      (SELECT count(*) FROM runs r WHERE r.tenant_id = t.id) runs,
      (SELECT max(started_at) FROM runs r WHERE r.tenant_id = t.id) last_run
    FROM tenants t ORDER BY t.created_at`).all(h));
}

export function users(db: DB, now = Date.now(), adminEmail?: string) {
  const h = hiddenUserIdsJson(db, adminEmail);
  return plain<{ id: number; email: string; name: string; role: string; tenant: string; created_at: number; sessions: number; last_seen: number | null; runs: number }>(db.prepare(`
    SELECT u.id, u.email, u.name, u.role, t.name tenant, u.created_at,
      (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) sessions,
      (SELECT max(coalesce(last_seen_at, created_at)) FROM sessions s WHERE s.user_id = u.id) last_seen,
      (SELECT count(*) FROM runs r WHERE r.created_by = u.id) runs
    FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id NOT IN (SELECT value FROM json_each(?)) ORDER BY u.created_at`).all(now, h));
}

/** Active sessions only. Never selects the session id (token hash); public_id identifies a session. */
export function sessions(db: DB, now = Date.now(), adminEmail?: string) {
  const h = hiddenUserIdsJson(db, adminEmail);
  return plain<{ public_id: string; email: string; tenant: string; created_at: number; last_seen_at: number | null; expires_at: number; remember: number; ip: string; user_agent: string }>(db.prepare(`
    SELECT s.public_id, u.email, t.name tenant, s.created_at, s.last_seen_at, s.expires_at, s.remember, s.ip, s.user_agent
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id
    WHERE s.expires_at > ? AND u.id NOT IN (SELECT value FROM json_each(?)) ORDER BY coalesce(s.last_seen_at, s.created_at) DESC`).all(now, h));
}

export function endAnySession(db: DB, publicId: string): boolean {
  return db.prepare("DELETE FROM sessions WHERE public_id = ?").run(publicId).changes > 0;
}

export function workflows(db: DB) {
  return plain<{ tenant: string; name: string; storage: string; github_repo: string | null; github_path: string | null; template_name: string | null; is_template: number; content_hash: string; approvals: number; rejections: number; runs: number; last_run: number | null; created_by: string | null; updated_at: number }>(db.prepare(`
    SELECT t.name tenant, w.name, w.storage, w.github_repo, w.github_path, w.template_name,
      (w.source LIKE '%template: true%') is_template, w.content_hash,
      (SELECT count(*) FROM workflow_approvals a WHERE a.tenant_id = w.tenant_id AND a.workflow = w.name AND a.content_hash = w.content_hash AND a.decision = 'approve') approvals,
      (SELECT count(*) FROM workflow_approvals a WHERE a.tenant_id = w.tenant_id AND a.workflow = w.name AND a.content_hash = w.content_hash AND a.decision = 'reject') rejections,
      (SELECT count(*) FROM runs r WHERE r.tenant_id = w.tenant_id AND r.workflow = w.name) runs,
      (SELECT max(started_at) FROM runs r WHERE r.tenant_id = w.tenant_id AND r.workflow = w.name) last_run,
      (SELECT email FROM users u WHERE u.id = w.created_by) created_by, w.updated_at
    FROM tenant_workflows w JOIN tenants t ON t.id = w.tenant_id ORDER BY t.name, w.name`).all());
}

export function systemTemplates(db: DB) {
  return plain<{ name: string; version: string; content_hash: string; created_at: number; instances: number }>(db.prepare(`
    SELECT wt.name, wt.version, wt.content_hash, wt.created_at,
      (SELECT count(*) FROM tenant_workflows w WHERE w.template_name = wt.name) instances
    FROM workflow_templates wt WHERE wt.current = 1 ORDER BY wt.name`).all());
}

/** Per-workflow run counts across tenants (includes legacy test-run rows). */
export function runsByWorkflow(db: DB) {
  return plain<{ workflow: string; runs: number; succeeded: number; failed: number }>(db.prepare(`
    SELECT coalesce(workflow, '(legacy)') workflow, count(*) runs,
      sum(status = 'succeeded') succeeded, sum(status = 'failed') failed
    FROM runs GROUP BY 1 ORDER BY 2 DESC`).all());
}

export type AdminRun = { id: string; tenant: string; workflow: string | null; status: string | null; email: string | null; repo: string; issue: number; started_at: number; ended_at: number | null; error: string | null;
  events: Array<{ step_id: string; status: string; attempt: number; output: string | null; truncated: number; at: number }> };

/** Recent runs with their step events (outputs are already redacted and capped when stored). */
export function executionLogs(db: DB, limit = 50, adminEmail?: string): AdminRun[] {
  const h = hiddenUserIdsJson(db, adminEmail);
  const runs = plain<Omit<AdminRun, "events">>(db.prepare(`
    SELECT r.id, t.name tenant, r.workflow, r.status, CASE WHEN u.id IN (SELECT value FROM json_each(?)) THEN NULL ELSE u.email END email, r.repo, r.issue, r.started_at, r.ended_at, r.error
    FROM runs r JOIN tenants t ON t.id = r.tenant_id LEFT JOIN users u ON u.id = r.created_by
    ORDER BY r.started_at DESC LIMIT ?`).all(h, limit));
  const ev = db.prepare("SELECT step_id, status, attempt, output, truncated, at FROM run_step_events WHERE run_id = ? ORDER BY id");
  return runs.map((r) => ({ ...r, events: plain(ev.all(r.id)) }));
}

export function approvals(db: DB, limit = 100) {
  return plain<{ tenant: string; workflow: string; content_hash: string; email: string; decision: string; comment: string; created_at: number; current: number }>(db.prepare(`
    SELECT t.name tenant, a.workflow, a.content_hash, u.email, a.decision, a.comment, a.created_at,
      EXISTS (SELECT 1 FROM tenant_workflows w WHERE w.tenant_id = a.tenant_id AND w.name = a.workflow AND w.content_hash = a.content_hash) current
    FROM workflow_approvals a JOIN tenants t ON t.id = a.tenant_id JOIN users u ON u.id = a.approver_id
    ORDER BY a.created_at DESC LIMIT ?`).all(limit));
}

export function rateLimits(db: DB, now = Date.now()) {
  const rows = plain<{ bucket: string; key: string; count: number; window_start: number; expires_at: number }>(db.prepare(
    "SELECT bucket, key, count, window_start, expires_at FROM rate_limits WHERE expires_at > ? ORDER BY bucket, count DESC").all(now));
  const limits = Object.values(LIMITS).map((l) => ({ ...l, blocked: rows.filter((r) => r.bucket === l.bucket && r.count >= l.max).length, tracked: rows.filter((r) => r.bucket === l.bucket).length }));
  return { rows: rows.map((r) => ({ ...r, max: Object.values(LIMITS).find((l) => l.bucket === r.bucket)?.max ?? null })), limits };
}

/** Request time for server components (keeps Date.now out of render for the purity lint rule). */
export const clock = () => Date.now();
