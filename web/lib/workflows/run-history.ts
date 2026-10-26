// Run history (audit trail) for one workflow: every execution, newest first, read-only.
// Scoping (enforced here, used by both the page and GET /api/workflows/<name>/runs):
// - members and team leads: only their own team's (tenant's) runs; a workflow their team
//   can't see is 404 (same answer as a missing one, so names can't be probed);
// - system admins (role admin): runs of that workflow across every team, with a team column.
// Cobra's working branches (cobra/<run-id>) are never shown; error text is redacted again.
import type { DB } from "../db";
const isSystemAdmin = (u: { role: string }) => u.role === "admin"; // same rule as lib/collab.ts
import { redact } from "./engine";
import { canViewRun } from "./runner";
import { findWorkflow, type Actor } from "./store";

export const HISTORY_FILTERS = ["all", "passed", "failed", "running"] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];
export const HISTORY_PER_PAGE = 25;

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
export function parseHistoryFilter(v: unknown): HistoryFilter {
  const s = String(first(v) ?? "").toLowerCase();
  return (HISTORY_FILTERS as readonly string[]).includes(s) ? (s as HistoryFilter) : "all";
}
export function parsePage(v: unknown): number {
  const n = Number.parseInt(String(first(v) ?? "1"), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : 1;
}

export type RunStatusLabel = "succeeded" | "failed" | "cancelled" | "running" | "unknown";
/** Engine status -> timeline status. Legacy rows without a status are "unknown". */
export function normalizeStatus(s: string | null): RunStatusLabel {
  if (s === "succeeded" || s === "failed" || s === "cancelled") return s;
  if (s === "running" || s === "pending" || s === "queued") return "running";
  return "unknown";
}
const FILTER_SQL: Record<HistoryFilter, string> = {
  all: "",
  passed: " AND r.status = 'succeeded'",
  failed: " AND r.status IN ('failed','cancelled')",
  running: " AND r.status IN ('running','pending','queued')",
};

/** Hides Cobra working branch names (cobra/<anything>) in free text. */
export const hideCobraBranches = (t: string) => t.replace(/\bcobra\/[A-Za-z0-9._\-/]+/g, "cobra/[hidden]");

/** First line of the run error, redacted and hidden-branch-scrubbed, capped. */
export function failureReason(error: string | null, secrets: Iterable<string> = []): string | null {
  if (!error) return null;
  const line = hideCobraBranches(redact(error, secrets)).split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export type HistoryEntry = {
  id: string; canOpen: boolean; triggeredBy: string; startedAt: number; endedAt: number | null; durationMs: number | null;
  mode: string | null; engine: string | null; status: RunStatusLabel; reason: string | null; team?: string;
};
export type HistoryPage = {
  workflow: string; scope: "team" | "all-teams"; filter: HistoryFilter; page: number; perPage: number; total: number; pages: number;
  counts: Record<HistoryFilter, number>; runs: HistoryEntry[];
};
type Res = { status: number; body: unknown };

/** Workflow visible to this user? Members/leads: their team's (incl. built-ins). Admins: theirs or any team's. */
function visible(db: DB, user: Actor, name: string, dir?: string): boolean {
  if (findWorkflow(db, user.tenantId, name, dir)) return true;
  if (!isSystemAdmin(user)) return false;
  return !!db.prepare("SELECT 1 FROM tenant_workflows WHERE name = ? UNION SELECT 1 FROM runs WHERE workflow = ? LIMIT 1").get(name, name);
}

export function workflowRunHistory(db: DB, user: Actor, name: string, opts: { filter?: HistoryFilter; page?: number; perPage?: number; secrets?: Iterable<string>; dir?: string } = {}): Res {
  if (!visible(db, user, name, opts.dir)) return { status: 404, body: { error: `workflow '${name}' not found` } };
  const admin = isSystemAdmin(user);
  const filter = opts.filter ?? "all", perPage = Math.max(1, Math.min(opts.perPage ?? HISTORY_PER_PAGE, 100));
  const scope = admin ? "" : " AND r.tenant_id = ?";
  const args: Array<string | number> = admin ? [name] : [name, user.tenantId];
  const count = (f: HistoryFilter) => (db.prepare(`SELECT count(*) AS n FROM runs r WHERE r.workflow = ?${scope}${FILTER_SQL[f]}`).get(...args) as { n: number }).n;
  const counts = Object.fromEntries(HISTORY_FILTERS.map((f) => [f, count(f)])) as Record<HistoryFilter, number>;
  const total = counts[filter], pages = Math.max(1, Math.ceil(total / perPage)), page = Math.min(opts.page ?? 1, pages);
  type Row = { id: string; tenant_id: number; created_by: number | null; triggered_by: string | null; started_at: number; ended_at: number | null; mode: string | null; simulated: number; engine: string | null; status: string | null; error: string | null; team: string | null };
  const rows = db.prepare(`SELECT r.id, r.tenant_id, r.created_by, r.triggered_by, r.started_at, r.ended_at, r.mode, r.simulated, r.engine, r.status, r.error, t.name AS team
    FROM runs r LEFT JOIN tenants t ON t.id = r.tenant_id WHERE r.workflow = ?${scope}${FILTER_SQL[filter]} ORDER BY r.started_at DESC, r.id DESC LIMIT ? OFFSET ?`)
    .all(...args, perPage, (page - 1) * perPage) as Row[];
  const secrets = [...(opts.secrets ?? [])];
  const runs = rows.map((r): HistoryEntry => ({
    id: r.id,
    canOpen: canViewRun(user, { createdBy: r.created_by, tenantId: r.tenant_id }),
    triggeredBy: r.triggered_by || "unknown",
    startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.ended_at != null ? Math.max(0, r.ended_at - r.started_at) : null,
    mode: r.mode ?? (r.simulated ? "simulated" : null), engine: r.engine,
    status: normalizeStatus(r.status), reason: failureReason(r.error, secrets),
    ...(admin ? { team: r.team ?? `team ${r.tenant_id}` } : {}),
  }));
  const body: HistoryPage = { workflow: name, scope: admin ? "all-teams" : "team", filter, page, perPage, total, pages, counts, runs };
  return { status: 200, body };
}
