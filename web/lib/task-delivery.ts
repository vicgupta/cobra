// After a task run finishes, deliver a short summary to the channels the task is set to use
// (email via the team's kantsy.com mailbox, and/or in-app notifications). Delivery errors are
// logged and never fail the run. The team's mailbox is capped at 60 sends/hour; extra recipients
// are skipped with a log line.
import type { DB } from "./db";
import { APP_URL } from "./digest";
import { KANTSY_API, teamEmailCredentials, teamHasMailbox } from "./team-email";
import { teamMembers } from "./team";
import { getTask, type Task } from "./tasks";

export const TEAM_EMAIL_HOUR_LIMIT = 60;
const HOUR = 60 * 60 * 1000;
const GH_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/g;

export type DeliverySend = (to: string, subject: string, body: string) => Promise<void>;
export type DeliveryDeps = { send?: DeliverySend; now?: number; secretKey?: string; fetchImpl?: typeof fetch };
export type DeliveryResult = "delivered" | "skipped" | "off" | "no-task" | "filtered" | "running";

export function teamEmailSendsInWindow(db: DB, tenantId: number, now: number, windowMs = HOUR): number {
  return (db.prepare("SELECT count(*) n FROM team_email_sends WHERE tenant_id = ? AND at > ?").get(tenantId, now - windowMs) as { n: number }).n;
}

/** Reserve up to `want` send slots in the last-hour window. Returns how many were reserved. */
export function reserveTeamEmailSends(db: DB, tenantId: number, want: number, now: number): number {
  const used = teamEmailSendsInWindow(db, tenantId, now);
  const n = Math.max(0, Math.min(want, TEAM_EMAIL_HOUR_LIMIT - used));
  const ins = db.prepare("INSERT INTO team_email_sends (tenant_id, at) VALUES (?, ?)");
  for (let i = 0; i < n; i++) ins.run(tenantId, now);
  return n;
}

export function extractLinks(run: { repo: string | null; issue: number; outputs: string | null; error: string | null; events?: string | null }): string[] {
  const found: string[] = [];
  const add = (u: string) => { if (!found.includes(u)) found.push(u); };
  if (run.repo && run.issue > 0) add(`https://github.com/${run.repo}/issues/${run.issue}`);
  const blob = [run.outputs, run.error, run.events].filter(Boolean).join("\n");
  for (const m of blob.matchAll(GH_URL)) add(m[0]);
  return found;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m} min ${r}s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function shouldDeliver(notifyOn: Task["notifyOn"], ok: boolean): boolean {
  if (notifyOn === "off") return false;
  if (notifyOn === "both") return true;
  if (notifyOn === "success") return ok;
  if (notifyOn === "failure") return !ok;
  return false;
}

type RunRow = {
  id: string; tenant_id: number; task_id: number | null; status: string | null; error: string | null;
  started_at: number; ended_at: number | null; repo: string | null; issue: number; workflow: string | null;
  outputs_json: string | null; agent: string;
};

function loadRun(db: DB, runId: string): RunRow | undefined {
  return db.prepare(`SELECT id, tenant_id, task_id, status, error, started_at, ended_at, repo, issue, workflow, outputs_json, agent
    FROM runs WHERE id = ?`).get(runId) as RunRow | undefined;
}

export function buildSummary(task: Task, run: RunRow, eventsText: string | null): { title: string; body: string; ok: boolean; links: string[] } {
  const ok = run.status === "succeeded";
  const status = ok ? "ok" : "failed";
  const skill = task.skillRef ? task.skillRef.replace(/^sop:/, "skill #") : "agent prompt";
  const dur = run.ended_at != null ? formatDuration(run.ended_at - run.started_at) : "n/a";
  const links = extractLinks({ repo: run.repo, issue: run.issue, outputs: run.outputs_json, error: run.error, events: eventsText });
  const runUrl = `${APP_URL}/runs/${encodeURIComponent(run.id)}`;
  const lines = [
    `Task: ${task.name}`,
    `Agent: ${task.agent} · ${skill}`,
    `Status: ${status}`,
    `Duration: ${dur}`,
    run.repo ? `Repo: ${run.repo}` : null,
    "",
    ...links.map((u) => u),
    links.length ? "" : null,
    `Run: ${runUrl}`,
  ].filter((l) => l !== null) as string[];
  if (!ok && run.error) {
    const err = run.error.replace(/\s+/g, " ").trim().slice(0, 400);
    if (err) lines.push("", err);
  } else if (ok && run.outputs_json) {
    const excerpt = run.outputs_json.replace(/\s+/g, " ").trim().slice(0, 280);
    if (excerpt && excerpt !== "{}" && excerpt !== "null") lines.push("", excerpt);
  }
  const title = `${task.name}: ${status}`;
  return { title, body: lines.join("\n"), ok, links };
}

export async function sendFromTeamMailbox(
  creds: { address: string; token: string }, to: string, subject: string, body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const r = await fetchImpl(`${KANTSY_API}/email`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: JSON.stringify({ to, subject, body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Email send failed: HTTP ${r.status}`);
}

function eventsText(db: DB, runId: string): string {
  const rows = db.prepare("SELECT output FROM run_step_events WHERE run_id = ? AND output IS NOT NULL").all(runId) as Array<{ output: string }>;
  return rows.map((r) => r.output).join("\n");
}

function insertInApp(db: DB, tenantId: number, taskId: number, runId: string, title: string, body: string, status: "ok" | "failed", now: number): number {
  const members = teamMembers(db, tenantId);
  const ins = db.prepare(`INSERT INTO run_notifications (tenant_id, user_id, run_id, task_id, title, body, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of members) ins.run(tenantId, m.id, runId, taskId, title, body, status, now);
  return members.length;
}

/**
 * Deliver a finished task run's summary. Safe to call for any run: no-ops when the run has no task,
 * delivery is off, or the status does not match the filter. Never throws to the caller of a well-wrapped hook;
 * email/in-app failures are caught and logged here.
 */
export async function deliverTaskResult(db: DB, runId: string, deps: DeliveryDeps = {}): Promise<DeliveryResult> {
  try {
    return await deliver(db, runId, deps);
  } catch (e) {
    console.error("[cobra] task delivery:", e instanceof Error ? e.message : e);
    return "skipped";
  }
}

async function deliver(db: DB, runId: string, deps: DeliveryDeps): Promise<DeliveryResult> {
  const now = deps.now ?? Date.now();
  const run = loadRun(db, runId);
  if (!run?.task_id) return "no-task";
  if (run.status === "running" || run.status == null) return "running";
  const task = getTask(db, run.tenant_id, run.task_id);
  if (!task) return "no-task";
  const ok = run.status === "succeeded";
  if (task.notifyOn === "off") return "off";
  if (!shouldDeliver(task.notifyOn, ok)) return "filtered";
  if (!task.notifyEmail && !task.notifyInApp) return "off";
  const summary = buildSummary(task, run, eventsText(db, runId));
  const status = summary.ok ? "ok" : "failed";

  if (task.notifyInApp) {
    try { insertInApp(db, run.tenant_id, task.id, run.id, summary.title, summary.body, status, now); }
    catch (e) { console.error("[cobra] task delivery in-app:", e instanceof Error ? e.message : e); }
  }

  if (task.notifyEmail) {
    if (!teamHasMailbox(db, run.tenant_id)) {
      console.error("[cobra] task delivery: skipped email (no team mailbox)");
    } else {
      const recipients = task.notifyEmails.filter((e) => teamMembers(db, run.tenant_id).some((m) => m.email === e));
      if (recipients.length) {
        const slots = reserveTeamEmailSends(db, run.tenant_id, recipients.length, now);
        const send = deps.send ?? (async (to, subject, body) => {
          const creds = teamEmailCredentials(db, run.tenant_id, deps.secretKey ?? process.env.COBRA_SECRET_KEY);
          if (!creds) throw new Error("team mailbox token unavailable");
          await sendFromTeamMailbox(creds, to, subject, body, deps.fetchImpl);
        });
        for (let i = 0; i < recipients.length; i++) {
          const to = recipients[i];
          if (i >= slots) { console.error(`[cobra] task delivery: skipped email to ${to} (60/hour team mailbox limit)`); continue; }
          try { await send(to, summary.title, summary.body); }
          catch (e) { console.error(`[cobra] task delivery: email to ${to} failed:`, e instanceof Error ? e.message : e); }
        }
      }
    }
  }
  return "delivered";
}
