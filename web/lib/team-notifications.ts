// Team notifications: a daily digest at 7:00 AM America/New_York to each team covering ONLY that team's
// last 24 hours, built by the shared digest builder (lib/digest.ts) in team scope. Every member sees the
// same digest in Settings > Notifications; the tenant is ALWAYS the signed-in user's own (never a request
// parameter). Recipient: the team's designated lead if set, otherwise its team lead(s). Team leads, the
// designated lead and system admins toggle it (team_audit) and send a test (to that same recipient);
// members view only. Sent from the digest address (cobra@kantsy.com). One daily send per team per NY date
// (unique index), catch-up until noon ET.
import { visibleRecipients } from "./members";
import type { DB } from "./db";
import { CollabError, designatedLead, isSystemAdmin } from "./collab";
import { CATCH_UP_UNTIL_HOUR, DAILY_HOUR, nyClock, type Send } from "./notifications";
import { buildDigest, digestHtml, digestSubject, digestText, type Digest } from "./digest";

type U = { id: number; email: string; role: string; tenantId: number };
type Action = "notify_toggle" | "notify_test";
const DIGEST = { sender: "digest" } as const;

export const canEditTeamNotify = (db: DB, u: U) => isSystemAdmin(u) || u.role === "team_lead" || designatedLead(db, u.tenantId)?.id === u.id;

const audit = (db: DB, u: U, action: Action, detail: string, now: number) =>
  db.prepare("INSERT INTO team_audit (tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)")
    .run(u.tenantId, u.id, u.email, action, detail.slice(0, 500), now);

function settings(db: DB, tenantId: number): { enabled: boolean; updatedAt: number | null; updatedBy: string | null } {
  const r = db.prepare("SELECT enabled, updated_at, updated_by FROM team_notification_settings WHERE tenant_id = ?").get(tenantId) as { enabled: number; updated_at: number | null; updated_by: string | null } | undefined;
  return r ? { enabled: !!r.enabled, updatedAt: r.updated_at, updatedBy: r.updated_by } : { enabled: true, updatedAt: null, updatedBy: null };
}

/** The designated lead if set, otherwise every team lead of this team. */
export function teamRecipients(db: DB, tenantId: number): string[] {
  const d = designatedLead(db, tenantId);
  if (d) return [d.email];
  return (db.prepare("SELECT email FROM users WHERE tenant_id = ? AND role = 'team_lead' ORDER BY email").all(tenantId) as { email: string }[]).map((r) => r.email);
}

export type SendRow = { kind: string; sendDate: string; status: string; error: string | null; at: number; recipients: string; triggeredBy: string | null };
export type TeamNotifyView = { tenantId: number; enabled: boolean; updatedAt: number | null; updatedBy: string | null; schedule: string;
  recipients: string[]; canEdit: boolean; lastSend: SendRow | null; recent: SendRow[] };

export function teamNotifyStatus(db: DB, u: U): TeamNotifyView {
  const s = settings(db, u.tenantId);
  const recent = (db.prepare("SELECT kind, send_date sendDate, status, error, at, recipients, triggered_by triggeredBy FROM team_notification_sends WHERE tenant_id = ? ORDER BY at DESC, id DESC LIMIT 10").all(u.tenantId) as SendRow[]).map((r) => ({ ...r, recipients: visibleRecipients(db, r.recipients) }));
  return { tenantId: u.tenantId, ...s, schedule: "Daily at 7:00 AM ET", recipients: visibleRecipients(db, teamRecipients(db, u.tenantId).join(", ")).split(", ").filter(Boolean), canEdit: canEditTeamNotify(db, u), lastSend: recent[0] ?? null, recent };
}

/** The in-app team view: the signed-in user's own team only. */
export const teamDigestFor = (db: DB, u: U, now = Date.now()): Digest => buildDigest(db, { kind: "team", tenantId: u.tenantId }, now);

export function setTeamNotifyEnabled(db: DB, u: U, enabled: unknown, now = Date.now()): TeamNotifyView {
  if (!canEditTeamNotify(db, u)) throw new CollabError(403, "only team leads, the designated lead and system admins can change team notifications");
  if (typeof enabled !== "boolean") throw new CollabError(400, "enabled must be true or false");
  db.prepare(`INSERT INTO team_notification_settings (tenant_id, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(u.tenantId, enabled ? 1 : 0, now, u.email);
  audit(db, u, "notify_toggle", `team daily digest ${enabled ? "enabled" : "disabled"}`, now);
  return teamNotifyStatus(db, u);
}

export type TeamReport = { since: number; until: number; text: string; html: string; subject: string; digest: Digest; counts: { runs: number; failed: number } };

export function buildTeamReport(db: DB, tenantId: number, now: number, test = false): TeamReport {
  const digest = buildDigest(db, { kind: "team", tenantId }, now);
  const subject = digestSubject(digest, nyClock(now).date, test);
  return { since: digest.since, until: now, text: digestText(digest), html: digestHtml(digest, subject), subject, digest, counts: { runs: digest.runs.total, failed: digest.runs.failed } };
}

async function deliver(db: DB, id: number, to: string[], subject: string, body: string, send: Send) {
  const errors: string[] = [];
  for (const r of to) { try { await send(r, subject, body, DIGEST); } catch (e) { errors.push(`${r}: ${e instanceof Error ? e.message : String(e)}`); } }
  const ok = errors.length < to.length;
  db.prepare("UPDATE team_notification_sends SET status = ?, error = ? WHERE id = ?").run(ok ? "sent" : "failed", errors.length ? errors.join("; ").slice(0, 500) : null, id);
  return ok;
}

export type TeamSendResult = "sent" | "failed" | "already" | "disabled" | "no-recipients";

/** Called every minute: for each team, send at most once per NY date from 7:00 until noon ET. */
export async function maybeSendTeamDaily(db: DB, send: Send, now = Date.now()): Promise<Record<number, TeamSendResult> | "not-due"> {
  const c = nyClock(now);
  if (c.hour < DAILY_HOUR || c.hour >= CATCH_UP_UNTIL_HOUR) return "not-due";
  const out: Record<number, TeamSendResult> = {};
  const teams = db.prepare("SELECT id, name FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM team_notification_sends s WHERE s.tenant_id = t.id AND s.kind = 'daily' AND s.send_date = ?) ORDER BY id").all(c.date) as Array<{ id: number; name: string }>;
  for (const t of teams) {
    const s = settings(db, t.id), to = s.enabled ? teamRecipients(db, t.id) : [];
    const status = !s.enabled || !to.length ? "skipped" : "sending";
    let id: number;
    try {
      id = Number(db.prepare("INSERT INTO team_notification_sends (tenant_id, kind, send_date, status, recipients, error, triggered_by, at) VALUES (?, 'daily', ?, ?, ?, ?, 'scheduler', ?)")
        .run(t.id, c.date, status, to.join(", "), !s.enabled ? "disabled" : !to.length ? "no recipient (no designated lead or team lead)" : null, now).lastInsertRowid);
    } catch (e) { if (e instanceof Error && /UNIQUE/i.test(e.message)) { out[t.id] = "already"; continue; } throw e; }
    if (status === "skipped") { out[t.id] = !s.enabled ? "disabled" : "no-recipients"; continue; }
    const rep = buildTeamReport(db, t.id, now);
    out[t.id] = (await deliver(db, id, to, rep.subject, rep.text, send)) ? "sent" : "failed";
  }
  return out;
}

/** Team leads, the designated lead and system admins: sends the own team's digest to the team recipient. Never claims the day. */
export async function sendTeamTestNow(db: DB, u: U, send: Send, now = Date.now()): Promise<TeamNotifyView> {
  if (!canEditTeamNotify(db, u)) throw new CollabError(403, "only team leads, the designated lead and system admins can send a test");
  const to = teamRecipients(db, u.tenantId);
  if (!to.length) throw new CollabError(400, "this team has no designated lead or team lead to send to");
  const r = db.prepare("INSERT INTO team_notification_sends (tenant_id, kind, send_date, status, recipients, triggered_by, at) VALUES (?, 'test', ?, 'sending', ?, ?, ?)").run(u.tenantId, nyClock(now).date, to.join(", "), u.email, now);
  audit(db, u, "notify_test", `test team digest to ${to.join(", ")}`, now);
  const rep = buildTeamReport(db, u.tenantId, now, true);
  await deliver(db, Number(r.lastInsertRowid), to, rep.subject, rep.text, send);
  return teamNotifyStatus(db, u);
}

export function listTeamNotifyAudit(db: DB, tenantId: number, limit = 15) {
  return (db.prepare("SELECT actor_email actorEmail, action, detail, at FROM team_audit WHERE tenant_id = ? AND action LIKE 'notify_%' ORDER BY at DESC, id DESC LIMIT ?").all(tenantId, limit) as Array<{ actorEmail: string; action: string; detail: string; at: number }>).map((r) => ({ ...r }));
}
