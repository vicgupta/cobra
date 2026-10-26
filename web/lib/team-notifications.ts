// Team notifications: a daily email at 7:00 AM America/New_York to each team, covering ONLY that team's
// last 24 hours (every query is filtered by tenant_id; no server health, other teams or admin metrics).
// Recipients: 'leads' (team leads + designated lead, the default) or 'all' (entire team), minus per-user
// opt-outs. Team leads and system admins edit; members see it and manage their own opt-out. One daily
// send per team per NY date (unique index), catch-up until noon ET. Every change goes to team_audit.
// The system-admin email (lib/notifications.ts) is untouched; this only reuses its clock helpers.
import type { DB } from "./db";
import { CollabError, designatedLead, isSystemAdmin } from "./collab";
import { APP_URL, CATCH_UP_UNTIL_HOUR, DAILY_HOUR, fmtNy, nyClock, type Send } from "./notifications";

const DAY = 24 * 60 * 60 * 1000;
export type Mode = "leads" | "all";
export const MODE_LABEL: Record<Mode, string> = { leads: "Team leads", all: "Entire team" };
type U = { id: number; email: string; role: string; tenantId: number };
type Action = "notify_toggle" | "notify_recipients" | "notify_optout" | "notify_optin" | "notify_test";

export const canEditTeamNotify = (u: { role: string }) => isSystemAdmin(u) || u.role === "team_lead";

const audit = (db: DB, u: U, action: Action, detail: string, now: number, target: { id: number; email: string } | null = null) =>
  db.prepare("INSERT INTO team_audit (tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, u.id, u.email, action, target?.id ?? null, target?.email ?? null, detail.slice(0, 500), now);

function settings(db: DB, tenantId: number): { enabled: boolean; mode: Mode; updatedAt: number | null; updatedBy: string | null } {
  const r = db.prepare("SELECT enabled, recipients_mode mode, updated_at, updated_by FROM team_notification_settings WHERE tenant_id = ?").get(tenantId) as { enabled: number; mode: Mode; updated_at: number | null; updated_by: string | null } | undefined;
  return r ? { enabled: !!r.enabled, mode: r.mode, updatedAt: r.updated_at, updatedBy: r.updated_by } : { enabled: true, mode: "leads", updatedAt: null, updatedBy: null };
}
const upsert = (db: DB, tenantId: number, col: "enabled" | "recipients_mode", v: number | string, by: string, now: number) =>
  db.prepare(`INSERT INTO team_notification_settings (tenant_id, ${col}, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET ${col} = excluded.${col}, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(tenantId, v, now, by);

/** Everyone the mode targets (before opt-outs), with whether they opted out. */
export function recipientCandidates(db: DB, tenantId: number, mode: Mode): Array<{ id: number; email: string; role: string; optedOut: boolean }> {
  const d = designatedLead(db, tenantId);
  const rows = db.prepare(`SELECT u.id, u.email, u.role, EXISTS (SELECT 1 FROM team_notification_optouts o WHERE o.tenant_id = u.tenant_id AND o.user_id = u.id) optedOut
    FROM users u WHERE u.tenant_id = ? ORDER BY u.email`).all(tenantId) as Array<{ id: number; email: string; role: string; optedOut: number }>;
  return rows.filter((r) => mode === "all" || r.role === "team_lead" || r.id === d?.id).map((r) => ({ id: r.id, email: r.email, role: r.role, optedOut: !!r.optedOut }));
}
export const resolvedRecipients = (db: DB, tenantId: number, mode = settings(db, tenantId).mode) =>
  recipientCandidates(db, tenantId, mode).filter((r) => !r.optedOut).map((r) => r.email);

export type SendRow = { kind: string; sendDate: string; status: string; error: string | null; at: number; recipients: string; triggeredBy: string | null };
export type TeamNotifyView = { tenantId: number; enabled: boolean; mode: Mode; modeLabel: string; updatedAt: number | null; updatedBy: string | null; schedule: string;
  candidates: ReturnType<typeof recipientCandidates>; recipients: string[]; canEdit: boolean; myOptOut: boolean; lastSend: SendRow | null; recent: SendRow[] };

export function teamNotifyStatus(db: DB, u: U): TeamNotifyView {
  const s = settings(db, u.tenantId), c = recipientCandidates(db, u.tenantId, s.mode);
  const recent = (db.prepare("SELECT kind, send_date sendDate, status, error, at, recipients, triggered_by triggeredBy FROM team_notification_sends WHERE tenant_id = ? ORDER BY at DESC, id DESC LIMIT 10").all(u.tenantId) as SendRow[]).map((r) => ({ ...r }));
  const myOptOut = !!db.prepare("SELECT 1 FROM team_notification_optouts WHERE tenant_id = ? AND user_id = ?").get(u.tenantId, u.id);
  return { tenantId: u.tenantId, ...s, modeLabel: MODE_LABEL[s.mode], schedule: "Daily at 7:00 AM America/New_York (DST-aware)", candidates: c, recipients: c.filter((r) => !r.optedOut).map((r) => r.email), canEdit: canEditTeamNotify(u), myOptOut, lastSend: recent[0] ?? null, recent };
}

export function setTeamNotifyEnabled(db: DB, u: U, enabled: unknown, now = Date.now()): TeamNotifyView {
  if (!canEditTeamNotify(u)) throw new CollabError(403, "only team leads and system admins can change team notifications");
  if (typeof enabled !== "boolean") throw new CollabError(400, "enabled must be true or false");
  upsert(db, u.tenantId, "enabled", enabled ? 1 : 0, u.email, now);
  audit(db, u, "notify_toggle", `team daily email ${enabled ? "enabled" : "disabled"}`, now);
  return teamNotifyStatus(db, u);
}

export function setTeamNotifyMode(db: DB, u: U, mode: unknown, now = Date.now()): TeamNotifyView {
  if (!canEditTeamNotify(u)) throw new CollabError(403, "only team leads and system admins can change team notifications");
  if (mode !== "leads" && mode !== "all") throw new CollabError(400, "recipients must be 'leads' or 'all'");
  const prev = settings(db, u.tenantId).mode;
  upsert(db, u.tenantId, "recipients_mode", mode, u.email, now);
  audit(db, u, "notify_recipients", `recipients: ${MODE_LABEL[prev]} -> ${MODE_LABEL[mode]}`, now);
  return teamNotifyStatus(db, u);
}

/** Any team member, for their own copy only. */
export function setMyOptOut(db: DB, u: U, optOut: unknown, now = Date.now()): TeamNotifyView {
  if (typeof optOut !== "boolean") throw new CollabError(400, "optOut must be true or false");
  if (optOut) db.prepare("INSERT OR IGNORE INTO team_notification_optouts (tenant_id, user_id, at) VALUES (?, ?, ?)").run(u.tenantId, u.id, now);
  else db.prepare("DELETE FROM team_notification_optouts WHERE tenant_id = ? AND user_id = ?").run(u.tenantId, u.id);
  audit(db, u, optOut ? "notify_optout" : "notify_optin", `${u.email} ${optOut ? "opted out of" : "opted back in to"} the team daily email`, now, { id: u.id, email: u.email });
  return teamNotifyStatus(db, u);
}

// ---------- the report (team-scoped: every query takes tenant_id) ----------
const table = (rows: Array<[string, string | number]>) => rows.length ? rows.map(([k, v]) => `  ${k}: ${v}`).join("\n") : "  (none)";
export type TeamReport = { since: number; until: number; text: string; counts: { runs: number; failed: number } };

export function buildTeamReport(db: DB, tenantId: number, now: number): TeamReport {
  const since = now - DAY, t = tenantId;
  const q = <T>(sql: string, ...a: Array<string | number>) => db.prepare(sql).all(...a) as T[];
  const one = <T>(sql: string, ...a: Array<string | number>) => db.prepare(sql).get(...a) as T;
  const team = one<{ name: string } | undefined>("SELECT name FROM tenants WHERE id = ?", t)?.name ?? `Team ${t}`;
  const runs = q<{ status: string; n: number }>("SELECT COALESCE(status, 'unknown') status, COUNT(*) n FROM runs WHERE tenant_id = ? AND started_at >= ? GROUP BY 1 ORDER BY n DESC", t, since);
  const total = runs.reduce((a, r) => a + r.n, 0), nFailed = runs.find((r) => r.status === "failed")?.n ?? 0;
  const byEngine = q<{ e: string; n: number; sim: number }>("SELECT COALESCE(engine, 'n/a') e, COUNT(*) n, SUM(simulated) sim FROM runs WHERE tenant_id = ? AND started_at >= ? GROUP BY 1 ORDER BY n DESC", t, since);
  const byProvider = q<{ p: string; n: number }>("SELECT u.provider p, COUNT(DISTINCT u.run_id) n FROM run_usage u JOIN runs r ON r.id = u.run_id WHERE r.tenant_id = ? AND r.started_at >= ? GROUP BY 1 ORDER BY n DESC", t, since);
  const failed = q<{ id: string; title: string; error: string | null }>("SELECT id, COALESCE(workflow, title) title, error FROM runs WHERE tenant_id = ? AND started_at >= ? AND status = 'failed' ORDER BY started_at DESC LIMIT 10", t, since);
  const usage = q<{ provider: string; model: string | null; tin: number | null; tout: number | null; cost: number | null; costed: number; n: number }>(
    "SELECT u.provider, u.model, SUM(u.input_tokens) tin, SUM(u.output_tokens) tout, SUM(u.cost_usd) cost, COUNT(u.cost_usd) costed, COUNT(*) n FROM run_usage u JOIN runs r ON r.id = u.run_id WHERE r.tenant_id = ? AND u.created_at >= ? GROUP BY u.provider, u.model ORDER BY (COALESCE(SUM(u.input_tokens),0) + COALESCE(SUM(u.output_tokens),0)) DESC LIMIT 15", t, since);
  const tokens = usage.reduce((a, u) => a + (u.tin ?? 0) + (u.tout ?? 0), 0);
  const costed = usage.filter((u) => u.costed > 0), cost = costed.length ? costed.reduce((a, u) => a + (u.cost ?? 0), 0) : null;
  const skillsChanged = q<{ name: string }>("SELECT name FROM skills WHERE tenant_id = ? AND builtin = 0 AND updated_at >= ? ORDER BY updated_at DESC LIMIT 10", t, since);
  const skillsPending = q<{ name: string }>("SELECT s.name FROM skills s WHERE s.tenant_id = ? AND s.builtin = 0 AND NOT EXISTS (SELECT 1 FROM skill_approvals a WHERE a.skill_id = s.id AND a.content_hash = s.content_hash AND a.decision = 'approve') ORDER BY s.name LIMIT 20", t);
  const wfChanged = q<{ name: string }>("SELECT name FROM tenant_workflows WHERE tenant_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 10", t, since);
  const wfPending = q<{ name: string }>("SELECT w.name FROM tenant_workflows w WHERE w.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM workflow_approvals a WHERE a.tenant_id = w.tenant_id AND a.workflow = w.name AND a.content_hash = w.content_hash AND a.decision = 'approve') ORDER BY w.name LIMIT 20", t);
  const collabCounts = q<{ action: string; n: number }>("SELECT action, COUNT(*) n FROM collab_audit WHERE tenant_id = ? AND at >= ? GROUP BY action ORDER BY n DESC", t, since);
  const collab = q<{ actor: string; action: string; repo: string; number: number | null; at: number }>("SELECT actor_email actor, action, repo, number, at FROM collab_audit WHERE tenant_id = ? AND at >= ? ORDER BY at DESC LIMIT 10", t, since);
  const auditRows = q<{ actor: string; action: string; target: string | null; detail: string; at: number }>("SELECT actor_email actor, action, target_email target, detail, at FROM team_audit WHERE tenant_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT 15", t, since);
  const jr = one<{ pending: number; fresh: number }>("SELECT SUM(status = 'pending') pending, SUM(created_at >= ?) fresh FROM join_requests WHERE tenant_id = ?", since, t);
  const inv = one<{ pending: number; sent: number; accepted: number }>("SELECT SUM(used_at IS NULL AND revoked_at IS NULL AND expires_at > ?) pending, SUM(created_at >= ?) sent, SUM(used_at >= ?) accepted FROM team_invites WHERE tenant_id = ?", now, since, since, t);
  const members = q<{ email: string; role: string }>("SELECT email, role FROM users WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at", t, since);
  const names = (r: Array<{ name: string }>) => (r.length ? r.map((x) => x.name).join(", ") : "none");

  const text = [
    `Cobra daily team summary for ${team}: ${fmtNy(since)} to ${fmtNy(now)}`,
    "",
    `RUNS (${total})`,
    table(runs.map((r) => [r.status, r.n])),
    "  By engine:", table(byEngine.map((r) => [`  ${r.e}`, `${r.n}${r.sim ? ` (${r.sim} simulated)` : ""}`])),
    "  By provider:", table(byProvider.map((r) => [`  ${r.p}`, r.n])),
    "",
    `FAILURES (${nFailed})`,
    failed.length ? failed.map((f) => `  - ${f.title} - ${(f.error ?? "").replace(/\s+/g, " ").slice(0, 160)}\n    ${APP_URL}/runs/${encodeURIComponent(f.id)}`).join("\n") : "  (none)",
    "",
    "TOKENS AND SPEND (display only; cost is engine-reported and may be missing)",
    `  Total tokens: ${tokens.toLocaleString("en-US")}; reported cost: ${cost == null ? "n/a" : `$${cost.toFixed(2)}`}`,
    table(usage.map((u) => [`${u.provider}${u.model ? ` / ${u.model}` : ""}`, `${((u.tin ?? 0) + (u.tout ?? 0)).toLocaleString("en-US")} tokens, ${u.costed ? `$${(u.cost ?? 0).toFixed(2)}` : "cost n/a"} (${u.n} steps)`])),
    "",
    "SKILLS AND WORKFLOWS",
    `  Skills changed (24h): ${names(skillsChanged)}`,
    `  Skills awaiting approval: ${names(skillsPending)}`,
    `  Workflows changed (24h): ${names(wfChanged)}`,
    `  Workflows awaiting approval: ${names(wfPending)}`,
    "",
    "ISSUES, PRS AND MERGES",
    table(collabCounts.map((c) => [c.action, c.n])),
    ...collab.map((c) => `  - ${fmtNy(c.at)} ${c.actor}: ${c.action} ${c.repo}${c.number != null ? `#${c.number}` : ""}`),
    "",
    "JOIN REQUESTS AND INVITES",
    `  Join requests: ${jr.fresh ?? 0} new, ${jr.pending ?? 0} pending`,
    `  Invites: ${inv.sent ?? 0} sent, ${inv.accepted ?? 0} accepted, ${inv.pending ?? 0} pending`,
    "",
    `NEW MEMBERS (${members.length})`,
    members.length ? members.map((m) => `  - ${m.email} (${m.role})`).join("\n") : "  (none)",
    "",
    "TEAM AUDIT HIGHLIGHTS",
    auditRows.length ? auditRows.map((a) => `  - ${fmtNy(a.at)} ${a.actor}: ${a.action}${a.target ? ` ${a.target}` : ""}${a.detail ? ` (${a.detail.slice(0, 120)})` : ""}`).join("\n") : "  (none)",
  ].join("\n");
  return { since, until: now, text, counts: { runs: total, failed: nFailed } };
}

async function deliver(db: DB, id: number, to: string[], subject: string, body: string, send: Send) {
  const errors: string[] = [];
  for (const r of to) { try { await send(r, subject, body); } catch (e) { errors.push(`${r}: ${e instanceof Error ? e.message : String(e)}`); } }
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
    const s = settings(db, t.id), to = s.enabled ? resolvedRecipients(db, t.id, s.mode) : [];
    const status = !s.enabled || !to.length ? "skipped" : "sending";
    let id: number;
    try {
      id = Number(db.prepare("INSERT INTO team_notification_sends (tenant_id, kind, send_date, status, recipients, error, triggered_by, at) VALUES (?, 'daily', ?, ?, ?, ?, 'scheduler', ?)")
        .run(t.id, c.date, status, to.join(", "), !s.enabled ? "disabled" : !to.length ? `no recipients (${MODE_LABEL[s.mode]}, after opt-outs)` : null, now).lastInsertRowid);
    } catch (e) { if (e instanceof Error && /UNIQUE/i.test(e.message)) { out[t.id] = "already"; continue; } throw e; }
    if (status === "skipped") { out[t.id] = !s.enabled ? "disabled" : "no-recipients"; continue; }
    const rep = buildTeamReport(db, t.id, now);
    out[t.id] = (await deliver(db, id, to, `Cobra team summary ${c.date} (${t.name}): ${rep.counts.runs} runs, ${rep.counts.failed} failed`, rep.text, send)) ? "sent" : "failed";
  }
  return out;
}

/** Team leads and system admins: sends the team's current report to the clicking user only. */
export async function sendTeamTestNow(db: DB, u: U, send: Send, now = Date.now()): Promise<TeamNotifyView> {
  if (!canEditTeamNotify(u)) throw new CollabError(403, "only team leads and system admins can send a test");
  const r = db.prepare("INSERT INTO team_notification_sends (tenant_id, kind, send_date, status, recipients, triggered_by, at) VALUES (?, 'test', ?, 'sending', ?, ?, ?)").run(u.tenantId, nyClock(now).date, u.email, u.email, now);
  audit(db, u, "notify_test", `test team email to ${u.email}`, now);
  const rep = buildTeamReport(db, u.tenantId, now);
  await deliver(db, Number(r.lastInsertRowid), [u.email], `[Test] Cobra team summary: ${rep.counts.runs} runs, ${rep.counts.failed} failed`, rep.text, send);
  return teamNotifyStatus(db, u);
}

export function listTeamNotifyAudit(db: DB, tenantId: number, limit = 15) {
  return (db.prepare("SELECT actor_email actorEmail, action, detail, at FROM team_audit WHERE tenant_id = ? AND action LIKE 'notify_%' ORDER BY at DESC, id DESC LIMIT ?").all(tenantId, limit) as Array<{ actorEmail: string; action: string; detail: string; at: number }>).map((r) => ({ ...r }));
}
