// System-admin notifications: a daily analytics email at 7:00 AM America/New_York to every system admin
// (users.role = 'admin'). Settings > Notifications (system admins only) toggles it, shows recipients and
// the last send, and can send a test to the signed-in admin only. Every send is a notification_sends row;
// the unique (send_date) index for kind 'daily' means a day is claimed once, so restarts or several
// processes can't double-send. Pure Node (no Next imports): mail and clock are injected so tests use a mock.
import { statfsSync, statSync } from "node:fs";
import os from "node:os";
import type { DB } from "./db";
import { CollabError, isSystemAdmin } from "./collab";

export const NOTIFY_TZ = "America/New_York";
export const DAILY_HOUR = 7;
/** A missed 7 AM send (server down) is still sent up to this hour ET; later it is skipped for that day. */
export const CATCH_UP_UNTIL_HOUR = 12;
export const APP_URL = "https://nova.kantsy.com";
const DAY = 24 * 60 * 60 * 1000;

export type Send = (to: string, subject: string, body: string) => Promise<void>;
type Admin = { id: number; email: string; role: string };

/** Wall-clock date (YYYY-MM-DD) and hour in New York for an instant: DST-correct via Intl. */
export function nyClock(now: number): { date: string; hour: number; minute: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: NOTIFY_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
export const fmtNy = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: NOTIFY_TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(t)) + " ET";

export const adminEmails = (db: DB) => (db.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY id").all() as { email: string }[]).map((r) => r.email);

export type NotificationView = { dailyEnabled: boolean; recipients: string[]; updatedAt: number | null; updatedBy: string | null; schedule: string;
  lastSend: { kind: string; sendDate: string; status: string; error: string | null; at: number; recipients: string } | null;
  recent: Array<{ kind: string; sendDate: string; status: string; error: string | null; at: number; recipients: string; triggeredBy: string | null }> };

export function notificationStatus(db: DB): NotificationView {
  const s = db.prepare("SELECT daily_enabled, updated_at, updated_by FROM notification_settings WHERE id = 1").get() as { daily_enabled: number; updated_at: number | null; updated_by: string | null };
  const recent = (db.prepare("SELECT kind, send_date sendDate, status, error, at, recipients, triggered_by triggeredBy FROM notification_sends ORDER BY at DESC, id DESC LIMIT 10").all() as NotificationView["recent"]).map((r) => ({ ...r }));
  return { dailyEnabled: !!s.daily_enabled, recipients: adminEmails(db), updatedAt: s.updated_at, updatedBy: s.updated_by, schedule: "Daily at 7:00 AM America/New_York (DST-aware)", lastSend: recent[0] ?? null, recent };
}

const audit = (db: DB, u: Admin, action: string, detail: string, now: number) =>
  db.prepare("INSERT INTO notification_audit (actor_id, actor_email, action, detail, at) VALUES (?, ?, ?, ?, ?)").run(u.id, u.email, action, detail, now);

export function listNotificationAudit(db: DB, limit = 20) {
  return (db.prepare("SELECT actor_email actorEmail, action, detail, at FROM notification_audit ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Array<{ actorEmail: string; action: string; detail: string; at: number }>).map((r) => ({ ...r }));
}

/** System admins only. */
export function setDailyEnabled(db: DB, u: Admin, enabled: unknown, now = Date.now()): NotificationView {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can change notifications");
  if (typeof enabled !== "boolean") throw new CollabError(400, "enabled must be true or false");
  db.prepare("UPDATE notification_settings SET daily_enabled = ?, updated_at = ?, updated_by = ? WHERE id = 1").run(enabled ? 1 : 0, now, u.email);
  audit(db, u, "daily_toggle", `daily analytics email ${enabled ? "enabled" : "disabled"}`, now);
  return notificationStatus(db);
}

// ---------- analytics ----------
const q = <T>(db: DB, sql: string, ...a: Array<string | number | null>) => db.prepare(sql).all(...a) as T[];
const one = <T>(db: DB, sql: string, ...a: Array<string | number | null>) => db.prepare(sql).get(...a) as T;

export type Health = { uptimeSec: number; diskFreeBytes: number | null; diskTotalBytes: number | null; dbBytes: number | null };
export function serviceHealth(dbFile?: string, dir = "/"): Health {
  let free: number | null = null, total: number | null = null, dbBytes: number | null = null;
  try { const s = statfsSync(dir); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch { /* unavailable */ }
  if (dbFile && dbFile !== ":memory:") { try { dbBytes = statSync(dbFile).size + (() => { try { return statSync(dbFile + "-wal").size; } catch { return 0; } })(); } catch { /* none */ } }
  return { uptimeSec: Math.round(os.uptime()), diskFreeBytes: free, diskTotalBytes: total, dbBytes };
}

export type DailyReport = { since: number; until: number; text: string; counts: { runs: number; failed: number; tokens: number; costUsd: number | null } };

const gb = (b: number | null) => (b == null ? "n/a" : `${(b / 1e9).toFixed(1)} GB`);
const mb = (b: number | null) => (b == null ? "n/a" : `${(b / 1e6).toFixed(1)} MB`);
const table = (rows: Array<[string, string | number]>) => rows.length ? rows.map(([k, v]) => `  ${k}: ${v}`).join("\n") : "  (none)";

/** The last 24 hours of activity across all teams (system-admin view). Display only. */
export function buildDailyReport(db: DB, now: number, health: Health): DailyReport {
  const since = now - DAY;
  const runs = q<{ status: string | null; n: number }>(db, "SELECT COALESCE(status, 'unknown') status, COUNT(*) n FROM runs WHERE started_at >= ? GROUP BY 1 ORDER BY n DESC", since);
  const total = runs.reduce((a, r) => a + r.n, 0);
  const byTeam = q<{ name: string; n: number }>(db, "SELECT t.name, COUNT(*) n FROM runs r JOIN tenants t ON t.id = r.tenant_id WHERE r.started_at >= ? GROUP BY t.id ORDER BY n DESC LIMIT 10", since);
  const byEngine = q<{ e: string; n: number; sim: number }>(db, "SELECT COALESCE(engine, 'n/a') e, COUNT(*) n, SUM(simulated) sim FROM runs WHERE started_at >= ? GROUP BY 1 ORDER BY n DESC", since);
  const failed = q<{ id: string; name: string; title: string; error: string | null }>(db, "SELECT r.id, t.name, COALESCE(r.workflow, r.title) title, r.error FROM runs r JOIN tenants t ON t.id = r.tenant_id WHERE r.started_at >= ? AND r.status = 'failed' ORDER BY r.started_at DESC LIMIT 10", since);
  const nFailed = runs.find((r) => r.status === "failed")?.n ?? 0;
  const usage = q<{ provider: string; model: string | null; tin: number | null; tout: number | null; cost: number | null; costed: number; n: number }>(db,
    "SELECT provider, model, SUM(input_tokens) tin, SUM(output_tokens) tout, SUM(cost_usd) cost, COUNT(cost_usd) costed, COUNT(*) n FROM run_usage WHERE created_at >= ? GROUP BY provider, model ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC LIMIT 15", since);
  const tokens = usage.reduce((a, u) => a + (u.tin ?? 0) + (u.tout ?? 0), 0);
  const costed = usage.filter((u) => u.cost != null);
  const cost = costed.length ? costed.reduce((a, u) => a + (u.cost ?? 0), 0) : null;
  const pendingSkills = one<{ n: number }>(db, "SELECT COUNT(*) n FROM skills s WHERE s.builtin = 0 AND NOT EXISTS (SELECT 1 FROM skill_approvals a WHERE a.skill_id = s.id AND a.content_hash = s.content_hash AND a.decision = 'approve')").n;
  const pendingWf = one<{ n: number }>(db, "SELECT COUNT(*) n FROM tenant_workflows w WHERE NOT EXISTS (SELECT 1 FROM workflow_approvals a WHERE a.tenant_id = w.tenant_id AND a.workflow = w.name AND a.content_hash = w.content_hash AND a.decision = 'approve')").n;
  const skillsChanged = one<{ n: number }>(db, "SELECT COUNT(*) n FROM skills WHERE updated_at >= ?", since).n;
  const wfChanged = one<{ n: number }>(db, "SELECT COUNT(*) n FROM tenant_workflows WHERE updated_at >= ?", since).n;
  const collab = q<{ action: string; n: number }>(db, "SELECT action, COUNT(*) n FROM collab_audit WHERE at >= ? GROUP BY action ORDER BY n DESC", since);
  const users = one<{ n: number }>(db, "SELECT COUNT(*) n FROM users").n;
  const newUsers = one<{ n: number }>(db, "SELECT COUNT(*) n FROM users WHERE created_at >= ?", since).n;
  const logins = one<{ n: number; u: number }>(db, "SELECT COUNT(*) n, COUNT(DISTINCT user_id) u FROM sessions WHERE created_at >= ?", since);
  const active = one<{ n: number }>(db, "SELECT COUNT(*) n FROM sessions WHERE expires_at > ?", now).n;
  const limits = q<{ bucket: string; n: number; keys: number }>(db, "SELECT bucket, SUM(count) n, COUNT(*) keys FROM rate_limits WHERE window_start >= ? GROUP BY bucket ORDER BY bucket", since);
  const auditRows = q<{ src: string; actor: string; what: string; at: number }>(db, `
    SELECT 'provider' src, actor_email actor, engine || COALESCE(': ' || detail, '') what, at FROM provider_audit WHERE at >= ?
    UNION ALL SELECT 'team', actor_email, action || COALESCE(' ' || target_email, ''), at FROM team_audit WHERE at >= ?
    UNION ALL SELECT 'skill', actor_email, action || CASE WHEN detail <> '' THEN ': ' || detail ELSE '' END, at FROM skill_audit WHERE at >= ?
    UNION ALL SELECT 'notifications', actor_email, detail, at FROM notification_audit WHERE at >= ?
    ORDER BY at DESC LIMIT 15`, since, since, since, since);

  const text = [
    `Cobra daily summary: ${fmtNy(since)} to ${fmtNy(now)}`,
    "",
    `RUNS (${total}, all teams)`,
    table(runs.map((r) => [r.status ?? "unknown", r.n])),
    "  By team:", table(byTeam.map((r) => [`  ${r.name}`, r.n])),
    "  By engine:", table(byEngine.map((r) => [`  ${r.e}`, `${r.n}${r.sim ? ` (${r.sim} simulated)` : ""}`])),
    "",
    `FAILURES (${nFailed})`,
    failed.length ? failed.map((f) => `  - ${f.name}: ${f.title} - ${(f.error ?? "").replace(/\s+/g, " ").slice(0, 160)}\n    ${APP_URL}/runs/${encodeURIComponent(f.id)}`).join("\n") : "  (none)",
    "",
    `TOKENS AND SPEND (display only; cost is engine-reported and may be missing, e.g. OpenCode/Cursor)`,
    `  Total tokens: ${tokens.toLocaleString("en-US")}; reported cost: ${cost == null ? "n/a" : `$${cost.toFixed(2)}`}`,
    table(usage.map((u) => [`${u.provider}${u.model ? ` / ${u.model}` : ""}`, `${((u.tin ?? 0) + (u.tout ?? 0)).toLocaleString("en-US")} tokens, ${u.costed ? `$${(u.cost ?? 0).toFixed(2)}` : "cost n/a"} (${u.n} steps)`])),
    "",
    "SKILLS AND WORKFLOWS",
    `  Skills edited/created (24h): ${skillsChanged}; awaiting approval: ${pendingSkills}`,
    `  Workflows edited/created (24h): ${wfChanged}; awaiting approval: ${pendingWf}`,
    "",
    "ISSUES, PRS AND MERGES (Cobra audit)",
    table(collab.map((c) => [c.action, c.n])),
    "",
    "USERS AND SIGN-INS",
    `  Users: ${users} (${newUsers} new); sign-ins: ${logins.n} by ${logins.u} users; active sessions: ${active}`,
    "  Rate-limit counters (failed logins, reset requests):", table(limits.map((l) => [`  ${l.bucket}`, `${l.n} attempts across ${l.keys} keys`])),
    "",
    "AUDIT HIGHLIGHTS",
    auditRows.length ? auditRows.map((a) => `  - ${fmtNy(a.at)} [${a.src}] ${a.actor}: ${a.what}`).join("\n") : "  (none)",
    "",
    "SERVICE HEALTH",
    `  Host uptime: ${(health.uptimeSec / 3600).toFixed(1)} h; disk free: ${gb(health.diskFreeBytes)} of ${gb(health.diskTotalBytes)}; DB size: ${mb(health.dbBytes)}`,
    "",
    `Settings > Notifications: ${APP_URL}/settings/notifications`,
  ].join("\n");
  return { since, until: now, text, counts: { runs: total, failed: nFailed, tokens, costUsd: cost } };
}

// ---------- sending ----------
async function deliver(db: DB, id: number, to: string[], subject: string, body: string, send: Send) {
  const errors: string[] = [];
  for (const r of to) { try { await send(r, subject, body); } catch (e) { errors.push(`${r}: ${e instanceof Error ? e.message : String(e)}`); } }
  const ok = errors.length < to.length;
  db.prepare("UPDATE notification_sends SET status = ?, error = ? WHERE id = ?").run(ok ? "sent" : "failed", errors.length ? errors.join("; ").slice(0, 500) : null, id);
  return ok;
}

/** Called every minute by the in-app scheduler. Sends at most once per New York date, from 7:00 until noon ET. */
export async function maybeSendDaily(db: DB, send: Send, now = Date.now(), health: () => Health = () => serviceHealth()): Promise<"sent" | "failed" | "not-due" | "already" | "disabled" | "no-recipients"> {
  const c = nyClock(now);
  if (c.hour < DAILY_HOUR || c.hour >= CATCH_UP_UNTIL_HOUR) return "not-due";
  if (db.prepare("SELECT 1 FROM notification_sends WHERE kind = 'daily' AND send_date = ?").get(c.date)) return "already";
  const enabled = !!(db.prepare("SELECT daily_enabled FROM notification_settings WHERE id = 1").get() as { daily_enabled: number }).daily_enabled;
  const to = adminEmails(db);
  // Claim the day first (unique index): a concurrent claimer gets a constraint error and stops.
  const status = !enabled || !to.length ? "skipped" : "sending";
  try {
    const r = db.prepare("INSERT INTO notification_sends (kind, send_date, status, recipients, error, triggered_by, at) VALUES ('daily', ?, ?, ?, ?, 'scheduler', ?)")
      .run(c.date, status, to.join(", "), !enabled ? "disabled" : !to.length ? "no system admins" : null, now);
    if (status === "skipped") return !enabled ? "disabled" : "no-recipients";
    const rep = buildDailyReport(db, now, health());
    return (await deliver(db, Number(r.lastInsertRowid), to, `Cobra daily summary ${c.date}: ${rep.counts.runs} runs, ${rep.counts.failed} failed`, rep.text, send)) ? "sent" : "failed";
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return "already";
    throw e;
  }
}

/** System admins only: sends the current report to the signed-in admin's own address (nobody else). */
export async function sendTestNow(db: DB, u: Admin, send: Send, now = Date.now(), health: () => Health = () => serviceHealth()): Promise<NotificationView> {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can send notifications");
  const r = db.prepare("INSERT INTO notification_sends (kind, send_date, status, recipients, triggered_by, at) VALUES ('test', ?, 'sending', ?, ?, ?)").run(nyClock(now).date, u.email, u.email, now);
  audit(db, u, "test_send", `test email to ${u.email}`, now);
  const rep = buildDailyReport(db, now, health());
  await deliver(db, Number(r.lastInsertRowid), [u.email], `[Test] Cobra daily summary: ${rep.counts.runs} runs, ${rep.counts.failed} failed`, rep.text, send);
  return notificationStatus(db);
}
