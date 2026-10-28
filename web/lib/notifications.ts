// System-admin notifications: a daily analytics email at 7:00 AM America/New_York to every system admin
// (COBRA_ADMIN_EMAIL, else users.role = 'admin'). notification_settings.daily_enabled toggles it (Settings > Notifications, admin section). Every send is a notification_sends row;
// the unique (send_date) index for kind 'daily' means a day is claimed once, so restarts or several
// processes can't double-send. Pure Node (no Next imports): mail and clock are injected so tests use a mock.
import { statfsSync, statSync } from "node:fs";
import os from "node:os";
import type { DB } from "./db";
import { CollabError, isSystemAdmin } from "./collab";
import { updateSummaryLine } from "./tool-updates";
import { buildDigest, digestHtml, digestSubject, digestText, type Digest, type Health } from "./digest";
import { currentAdminEmail } from "./members";
import { buildAdminChanges, setLastReportedCommit, type SysInfo } from "./admin-changes";

/** Host facts for the admin change sections; without a collector only DB-derived facts are shown. */
export type SysFn = (h: Health) => SysInfo;
export const basicSys: SysFn = (h) => ({ nodeVersion: process.version, appCommit: null, processUptimeSec: null, backups: null, diskFreeBytes: h.diskFreeBytes, diskTotalBytes: h.diskTotalBytes, dbBytes: h.dbBytes, hostUptimeSec: h.uptimeSec });

export const NOTIFY_TZ = "America/New_York";
export const DAILY_HOUR = 7;
/** A missed 7 AM send (server down) is still sent up to this hour ET; later it is skipped for that day. */
export const CATCH_UP_UNTIL_HOUR = 12;
export { APP_URL, fmtNy } from "./digest";

/** Mail transport. sender "digest" = the digest From address (COBRA_DIGEST_FROM, default cobra@kantsy.com), resolved in lib/mail.ts. */
export type Send = (to: string, subject: string, body: string, opts?: { sender?: "digest" }) => Promise<void>;
const DIGEST = { sender: "digest" } as const;
type Admin = { id: number; email: string; role: string };

/** Wall-clock date (YYYY-MM-DD) and hour in New York for an instant: DST-correct via Intl. */
export function nyClock(now: number): { date: string; hour: number; minute: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: NOTIFY_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

export const adminEmails = (db: DB) => (db.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY id").all() as { email: string }[]).map((r) => r.email);
/** The admin digest's one recipient list: COBRA_ADMIN_EMAIL (env file, read fresh), else every role-admin address. Not editable. */
export function digestRecipients(db: DB, adminEmail = currentAdminEmail()): string[] {
  const a = adminEmail.trim();
  return a ? [a] : adminEmails(db);
}

export type NotificationView = { dailyEnabled: boolean; recipients: string[]; updatedAt: number | null; updatedBy: string | null; schedule: string;
  lastSend: { kind: string; sendDate: string; status: string; error: string | null; at: number; recipients: string } | null;
  recent: Array<{ kind: string; sendDate: string; status: string; error: string | null; at: number; recipients: string; triggeredBy: string | null }> };

/** Admin-only view: recipients are shown unscrubbed (the viewer is the system admin). */
export function notificationStatus(db: DB, adminEmail = currentAdminEmail()): NotificationView {
  const s = db.prepare("SELECT daily_enabled, updated_at, updated_by FROM notification_settings WHERE id = 1").get() as { daily_enabled: number; updated_at: number | null; updated_by: string | null };
  const recent = (db.prepare("SELECT kind, send_date sendDate, status, error, at, recipients, triggered_by triggeredBy FROM notification_sends ORDER BY at DESC, id DESC LIMIT 10").all() as NotificationView["recent"]);
  return { dailyEnabled: !!s.daily_enabled, recipients: digestRecipients(db, adminEmail), updatedAt: s.updated_at, updatedBy: s.updated_by, schedule: "Daily at 7:00 AM ET", lastSend: recent[0] ?? null, recent };
}

const audit = (db: DB, u: Admin, action: string, detail: string, now: number) =>
  db.prepare("INSERT INTO notification_audit (actor_id, actor_email, action, detail, at) VALUES (?, ?, ?, ?, ?)").run(u.id, u.email, action, detail, now);

export function listNotificationAudit(db: DB, limit = 20) {
  return (db.prepare("SELECT actor_email actorEmail, action, detail, at FROM notification_audit ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Array<{ actorEmail: string; action: string; detail: string; at: number }>).map((r) => ({ ...r }));
}

/** System admins only. */
export function setDailyEnabled(db: DB, u: Admin, enabled: unknown, now = Date.now(), adminEmail = currentAdminEmail()): NotificationView {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can change notifications");
  if (typeof enabled !== "boolean") throw new CollabError(400, "enabled must be true or false");
  db.prepare("UPDATE notification_settings SET daily_enabled = ?, updated_at = ?, updated_by = ? WHERE id = 1").run(enabled ? 1 : 0, now, u.email);
  audit(db, u, "daily_toggle", `daily analytics email ${enabled ? "enabled" : "disabled"}`, now);
  return notificationStatus(db, adminEmail);
}

// ---------- analytics (shared builder in lib/digest.ts, all-teams scope) ----------
export { type Health } from "./digest";
export function serviceHealth(dbFile?: string, dir = "/"): Health {
  let free: number | null = null, total: number | null = null, dbBytes: number | null = null;
  try { const s = statfsSync(dir); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch { /* unavailable */ }
  if (dbFile && dbFile !== ":memory:") { try { dbBytes = statSync(dbFile).size + (() => { try { return statSync(dbFile + "-wal").size; } catch { return 0; } })(); } catch { /* none */ } }
  return { uptimeSec: Math.round(os.uptime()), diskFreeBytes: free, diskTotalBytes: total, dbBytes };
}

export type DailyReport = { since: number; until: number; text: string; html: string; subject: string; digest: Digest; counts: { runs: number; failed: number; tokens: number; costUsd: number | null } };

/** The admin page's live preview: the digest as of now. */
export const adminDigestNow = (db: DB, health: Health, sys: SysFn = basicSys) => buildDailyReport(db, Date.now(), health, false, sys).digest;

/** The last 24 hours across all teams (system-admin digest). */
export function buildDailyReport(db: DB, now: number, health: Health, test = false, sys: SysFn = basicSys): DailyReport {
  const digest = buildDigest(db, { kind: "all" }, now, { health, updates: updateSummaryLine(db, nyClock(now).date) });
  const info = sys(health);
  digest.admin = buildAdminChanges(db, now, info);
  digest.appCommit = info.appCommit;
  const subject = digestSubject(digest, nyClock(now).date, test);
  return { since: digest.since, until: now, text: digestText(digest), html: digestHtml(digest, subject), subject, digest,
    counts: { runs: digest.runs.total, failed: digest.runs.failed, tokens: digest.costs.tokens, costUsd: digest.costs.costUsd } };
}

// ---------- sending ----------
async function deliver(db: DB, id: number, to: string[], subject: string, body: string, send: Send) {
  const errors: string[] = [];
  for (const r of to) { try { await send(r, subject, body, DIGEST); } catch (e) { errors.push(`${r}: ${e instanceof Error ? e.message : String(e)}`); } }
  const ok = errors.length < to.length;
  db.prepare("UPDATE notification_sends SET status = ?, error = ? WHERE id = ?").run(ok ? "sent" : "failed", errors.length ? errors.join("; ").slice(0, 500) : null, id);
  return ok;
}

/** Called every minute by the in-app scheduler. Sends at most once per New York date, from 7:00 until noon ET. */
export async function maybeSendDaily(db: DB, send: Send, now = Date.now(), health: () => Health = () => serviceHealth(), adminEmail = currentAdminEmail(), sys: SysFn = basicSys): Promise<"sent" | "failed" | "not-due" | "already" | "disabled" | "no-recipients"> {
  const c = nyClock(now);
  const o = db.prepare("SELECT oneoff_date d, oneoff_hour h, oneoff_sent_at s FROM notification_settings WHERE id = 1").get() as { d: string | null; h: number | null; s: number | null };
  if (o.d === c.date && o.h != null) return oneOffSend(db, send, now, o.h, health, adminEmail, sys);
  if (c.hour < DAILY_HOUR || c.hour >= CATCH_UP_UNTIL_HOUR) return "not-due";
  if (db.prepare("SELECT 1 FROM notification_sends WHERE kind = 'daily' AND send_date = ?").get(c.date)) return "already";
  const enabled = !!(db.prepare("SELECT daily_enabled FROM notification_settings WHERE id = 1").get() as { daily_enabled: number }).daily_enabled;
  const to = digestRecipients(db, adminEmail);
  // Claim the day first (unique index): a concurrent claimer gets a constraint error and stops.
  const status = !enabled || !to.length ? "skipped" : "sending";
  try {
    const r = db.prepare("INSERT INTO notification_sends (kind, send_date, status, recipients, error, triggered_by, at) VALUES ('daily', ?, ?, ?, ?, 'scheduler', ?)")
      .run(c.date, status, to.join(", "), !enabled ? "disabled" : !to.length ? "no recipient (COBRA_ADMIN_EMAIL unset, no admins)" : null, now);
    if (status === "skipped") return !enabled ? "disabled" : "no-recipients";
    const rep = buildDailyReport(db, now, health(), false, sys);
    const ok = await deliver(db, Number(r.lastInsertRowid), to, rep.subject, rep.text, send);
    if (ok) setLastReportedCommit(db, rep.digest.appCommit ?? null);
    return ok ? "sent" : "failed";
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return "already";
    throw e;
  }
}

/** One-off day (notification_settings.oneoff_date = today ET): the 7 AM send is replaced by one send at oneoff_hour
 *  (until noon). Claimed by oneoff_sent_at so it goes once; logged as a notification_sends row with kind 'test' and
 *  triggered_by 'scheduler (one-off)' because the day's 'daily' slot may already hold a 'skipped' row. */
async function oneOffSend(db: DB, send: Send, now: number, hour: number, health: () => Health, adminEmail: string, sys: SysFn) {
  const c = nyClock(now);
  if (c.hour < hour || c.hour >= CATCH_UP_UNTIL_HOUR) return "not-due" as const;
  if (!(db.prepare("SELECT daily_enabled FROM notification_settings WHERE id = 1").get() as { daily_enabled: number }).daily_enabled) return "disabled" as const;
  const to = digestRecipients(db, adminEmail);
  if (!to.length) return "no-recipients" as const;
  if (!db.prepare("UPDATE notification_settings SET oneoff_sent_at = ? WHERE id = 1 AND oneoff_sent_at IS NULL AND oneoff_date = ?").run(now, c.date).changes) return "already" as const;
  const r = db.prepare("INSERT INTO notification_sends (kind, send_date, status, recipients, triggered_by, at) VALUES ('test', ?, 'sending', ?, 'scheduler (one-off)', ?)").run(c.date, to.join(", "), now);
  const rep = buildDailyReport(db, now, health(), false, sys);
  const ok = await deliver(db, Number(r.lastInsertRowid), to, rep.subject, rep.text, send);
  if (ok) setLastReportedCommit(db, rep.digest.appCommit ?? null);
  return ok ? "sent" as const : "failed" as const;
}

/** System admins only: sends the current digest to the digest recipient (same as 7 AM). kind 'test' never claims the day. */
export async function sendTestNow(db: DB, u: Admin, send: Send, now = Date.now(), health: () => Health = () => serviceHealth(), adminEmail = currentAdminEmail(), sys: SysFn = basicSys): Promise<NotificationView> {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can send notifications");
  const to = digestRecipients(db, adminEmail);
  if (!to.length) throw new CollabError(400, "no digest recipient (COBRA_ADMIN_EMAIL unset and no admins)");
  const r = db.prepare("INSERT INTO notification_sends (kind, send_date, status, recipients, triggered_by, at) VALUES ('test', ?, 'sending', ?, ?, ?)").run(nyClock(now).date, to.join(", "), u.email, now);
  audit(db, u, "test_send", `test digest to ${to.join(", ")}`, now);
  const rep = buildDailyReport(db, now, health(), true, sys);
  await deliver(db, Number(r.lastInsertRowid), to, rep.subject, rep.text, send);
  return notificationStatus(db, adminEmail);
}
