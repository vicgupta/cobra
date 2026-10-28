// Shared analytics digest (last 24 hours): one builder for the system-admin all-teams email and the
// per-team email/view. Scope is a parameter: { kind: "all" } or { kind: "team", tenantId }. In team
// scope EVERY query is filtered by runs.tenant_id (run_usage has no tenant column, so it is always
// joined through runs). Pure Node, no Next imports; display only.
import type { DB } from "./db";
import type { AdminSection } from "./admin-changes";

export const APP_URL = "https://nova.kantsy.com";
export const DIGEST_TZ = "America/New_York";
const DAY = 24 * 60 * 60 * 1000;
/** A run still "running" this long after it started is listed as possibly stuck. */
export const STUCK_AFTER_MS = 60 * 60 * 1000;

export type DigestScope = { kind: "all" } | { kind: "team"; tenantId: number };
export type Health = { uptimeSec: number; diskFreeBytes: number | null; diskTotalBytes: number | null; dbBytes: number | null };
type N = number;
export type Digest = {
  scope: DigestScope; teamName: string | null; since: N; until: N;
  runs: { total: N; failed: N; byStatus: Array<{ status: string; n: N }>; byEngine: Array<{ engine: string; n: N; simulated: N }>; byTeam: Array<{ team: string; n: N; failed: N }> };
  costs: { tokens: N; costUsd: N | null; byModel: Array<{ provider: string; model: string | null; tokens: N; costUsd: N | null; steps: N }>; byTeam: Array<{ team: string; tokens: N; costUsd: N | null }> };
  errors: { groups: Array<{ team: string | null; engine: string; agent: string; n: N }>; top: Array<{ message: string; n: N; lastRunId: string }>; stuck: Array<{ id: string; team: string | null; engine: string; agent: string; startedAt: N }> };
  extra: { health: string | null; updates: string | null };
  /** All-teams scope only: the system-admin change sections (lib/admin-changes.ts). */
  admin?: AdminSection[];
  appCommit?: string | null;
};

export const fmtNy = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: DIGEST_TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(t)) + " ET";
const gb = (b: N | null) => (b == null ? "n/a" : `${(b / 1e9).toFixed(1)} GB`);
const mb = (b: N | null) => (b == null ? "n/a" : `${(b / 1e6).toFixed(1)} MB`);
export const healthLine = (h: Health) => `Host uptime ${(h.uptimeSec / 3600).toFixed(1)} h; disk free ${gb(h.diskFreeBytes)} of ${gb(h.diskTotalBytes)}; DB ${mb(h.dbBytes)}`;
const usd = (c: N | null) => (c == null ? "n/a" : `$${c.toFixed(2)}`);
const tok = (n: N) => n.toLocaleString("en-US");

/** extra: all-teams scope only (health and the 4 AM update line); ignored in team scope. */
export function buildDigest(db: DB, scope: DigestScope, now: number, extra: { health?: Health; updates?: string } = {}): Digest {
  const since = now - DAY;
  const team = scope.kind === "team";
  // "AND r.tenant_id = ?" in team scope; the bound args always start with the tenant id when present.
  const T = team ? " AND r.tenant_id = ?" : "";
  const a = (...rest: Array<string | N>) => (team ? [scope.tenantId, ...rest] : rest);
  const q = <R>(sql: string, ...args: Array<string | N>) => db.prepare(sql).all(...args) as R[];
  const teamName = team ? ((db.prepare("SELECT name FROM tenants WHERE id = ?").get(scope.tenantId) as { name: string } | undefined)?.name ?? `Team ${scope.tenantId}`) : null;

  const byStatus = q<{ status: string; n: N }>(`SELECT COALESCE(r.status, 'unknown') status, COUNT(*) n FROM runs r WHERE 1=1${T} AND r.started_at >= ? GROUP BY 1 ORDER BY n DESC, 1`, ...a(since));
  const byEngine = q<{ engine: string; n: N; simulated: N }>(`SELECT COALESCE(r.engine, 'n/a') engine, COUNT(*) n, COALESCE(SUM(r.simulated), 0) simulated FROM runs r WHERE 1=1${T} AND r.started_at >= ? GROUP BY 1 ORDER BY n DESC, 1`, ...a(since));
  const byTeam = team ? [] : q<{ team: string; n: N; failed: N }>("SELECT t.name team, COUNT(*) n, SUM(r.status = 'failed') failed FROM runs r JOIN tenants t ON t.id = r.tenant_id WHERE r.started_at >= ? GROUP BY t.id ORDER BY n DESC, t.name", since);
  const total = byStatus.reduce((s, r) => s + r.n, 0), failed = byStatus.find((r) => r.status === "failed")?.n ?? 0;

  const byModelRaw = q<{ provider: string; model: string | null; tin: N | null; tout: N | null; cost: N | null; costed: N; steps: N }>(
    `SELECT u.provider, u.model, SUM(u.input_tokens) tin, SUM(u.output_tokens) tout, SUM(u.cost_usd) cost, COUNT(u.cost_usd) costed, COUNT(*) steps
     FROM run_usage u JOIN runs r ON r.id = u.run_id WHERE 1=1${T} AND u.created_at >= ? GROUP BY u.provider, u.model
     ORDER BY COALESCE(SUM(u.input_tokens),0) + COALESCE(SUM(u.output_tokens),0) DESC LIMIT 15`, ...a(since));
  const byModel = byModelRaw.map((u) => ({ provider: u.provider, model: u.model, tokens: (u.tin ?? 0) + (u.tout ?? 0), costUsd: u.costed ? u.cost ?? 0 : null, steps: u.steps }));
  const tokens = byModel.reduce((s, u) => s + u.tokens, 0);
  const costed = byModel.filter((u) => u.costUsd != null), costUsd = costed.length ? costed.reduce((s, u) => s + (u.costUsd ?? 0), 0) : null;
  const costByTeam = team ? [] : q<{ team: string; tin: N | null; tout: N | null; cost: N | null; costed: N }>(
    "SELECT t.name team, SUM(u.input_tokens) tin, SUM(u.output_tokens) tout, SUM(u.cost_usd) cost, COUNT(u.cost_usd) costed FROM run_usage u JOIN runs r ON r.id = u.run_id JOIN tenants t ON t.id = r.tenant_id WHERE u.created_at >= ? GROUP BY t.id ORDER BY COALESCE(SUM(u.input_tokens),0) + COALESCE(SUM(u.output_tokens),0) DESC", since)
    .map((r) => ({ team: r.team, tokens: (r.tin ?? 0) + (r.tout ?? 0), costUsd: r.costed ? r.cost ?? 0 : null }));

  const groups = q<{ team: string | null; engine: string; agent: string; n: N }>(
    `SELECT ${team ? "NULL" : "t.name"} team, COALESCE(r.engine, 'n/a') engine, COALESCE(r.agent, 'n/a') agent, COUNT(*) n FROM runs r JOIN tenants t ON t.id = r.tenant_id
     WHERE r.status = 'failed'${T} AND r.started_at >= ? GROUP BY ${team ? "" : "t.id, "}2, 3 ORDER BY n DESC, 2, 3 LIMIT 20`, ...a(since));
  const top = q<{ message: string; n: N; lastRunId: string }>(
    `SELECT substr(COALESCE(NULLIF(trim(r.error), ''), '(no error message)'), 1, 200) message, COUNT(*) n, (SELECT r2.id FROM runs r2 WHERE r2.status = 'failed' AND r2.started_at >= ?${team ? " AND r2.tenant_id = ?" : ""} AND substr(COALESCE(NULLIF(trim(r2.error), ''), '(no error message)'), 1, 200) = substr(COALESCE(NULLIF(trim(r.error), ''), '(no error message)'), 1, 200) ORDER BY r2.started_at DESC LIMIT 1) lastRunId
     FROM runs r WHERE r.status = 'failed'${T} AND r.started_at >= ? GROUP BY 1 ORDER BY n DESC, 1 LIMIT 10`, ...(team ? [since, scope.tenantId, scope.tenantId, since] : [since, since]));
  const stuck = q<{ id: string; team: string | null; engine: string; agent: string; startedAt: N }>(
    `SELECT r.id, ${team ? "NULL" : "t.name"} team, COALESCE(r.engine, 'n/a') engine, COALESCE(r.agent, 'n/a') agent, r.started_at startedAt FROM runs r JOIN tenants t ON t.id = r.tenant_id
     WHERE r.status = 'running'${T} AND r.started_at < ? ORDER BY r.started_at LIMIT 20`, ...a(now - STUCK_AFTER_MS));

  return {
    scope, teamName, since, until: now,
    runs: { total, failed, byStatus, byEngine, byTeam },
    costs: { tokens, costUsd, byModel, byTeam: costByTeam },
    errors: { groups, top, stuck },
    extra: { health: !team && extra.health ? healthLine(extra.health) : null, updates: !team && extra.updates ? extra.updates : null },
  };
}

const lines = (rows: string[]) => (rows.length ? rows.map((r) => `  ${r}`) : ["  (none)"]);

export function digestSubject(d: Digest, date: string, test = false) {
  const who = d.teamName ? `Cobra team digest ${date} (${d.teamName})` : `Cobra daily digest ${date} (all teams)`;
  return `${test ? "[Test] " : ""}${who}: ${d.runs.total} runs, ${d.runs.failed} failed, ${usd(d.costs.costUsd)}`;
}

/** Plain-text email body. */
export function digestText(d: Digest): string {
  return [
    `${d.teamName ? `Cobra team digest for ${d.teamName}` : "Cobra daily digest, all teams"}: ${fmtNy(d.since)} to ${fmtNy(d.until)}`,
    "",
    `USAGE (${d.runs.total} runs, ${d.runs.failed} failed)`,
    "  By status:", ...lines(d.runs.byStatus.map((r) => `  ${r.status}: ${r.n}`)),
    "  By engine:", ...lines(d.runs.byEngine.map((r) => `  ${r.engine}: ${r.n}${r.simulated ? ` (${r.simulated} simulated)` : ""}`)),
    ...(d.teamName ? [] : ["  By team:", ...lines(d.runs.byTeam.map((r) => `  ${r.team}: ${r.n} (${r.failed} failed)`))]),
    "",
    `COSTS (${tok(d.costs.tokens)} tokens, ${usd(d.costs.costUsd)} engine-reported; cost may be missing for some engines)`,
    ...(d.teamName ? [] : ["  By team:", ...lines(d.costs.byTeam.map((r) => `  ${r.team}: ${tok(r.tokens)} tokens, ${usd(r.costUsd)}`))]),
    "  By provider / model:", ...lines(d.costs.byModel.map((u) => `  ${u.provider}${u.model ? ` / ${u.model}` : ""}: ${tok(u.tokens)} tokens, ${usd(u.costUsd)} (${u.steps} steps)`)),
    "",
    `ERRORS (${d.runs.failed} failed runs)`,
    `  By ${d.teamName ? "" : "team, "}engine and agent:`, ...lines(d.errors.groups.map((g) => `  ${g.team ? `${g.team} / ` : ""}${g.engine} / ${g.agent}: ${g.n}`)),
    "  Top failure messages:", ...lines(d.errors.top.map((t) => `  ${t.n}x ${t.message.replace(/\s+/g, " ")}\n      ${APP_URL}/runs/${encodeURIComponent(t.lastRunId)}`)),
    `  Possibly stuck (still "running" after ${STUCK_AFTER_MS / 3_600_000} h):`, ...lines(d.errors.stuck.map((s) => `  ${s.team ? `${s.team} / ` : ""}${s.engine} / ${s.agent}, started ${fmtNy(s.startedAt)}: ${APP_URL}/runs/${encodeURIComponent(s.id)}`)),
    ...(d.admin ?? []).flatMap((sec) => ["", sec.title, ...sec.lines.map((l) => `  ${l}`)]),
    ...(d.extra.health || d.extra.updates ? ["", "SERVICE", ...(d.extra.health ? [`  ${d.extra.health}`] : []), ...(d.extra.updates ? [`  4 AM tool updates: ${d.extra.updates}`] : [])] : []),
    "",
  ].join("\n");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const tbl = (head: string[], rows: Array<Array<string | N>>) => rows.length
  ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : `<p class="none">None</p>`;

/** HTML rendering of the same digest (preview / future HTML mail). */
export function digestHtml(d: Digest, subject: string): string {
  const all = !d.teamName;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(subject)}</title><style>
body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;background:#f4f4f5;margin:0;padding:24px}
.wrap{max-width:720px;margin:auto;background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:24px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #e4e4e7;padding-bottom:4px}
.meta{color:#71717a;font-size:12px}table{border-collapse:collapse;width:100%;margin:4px 0 10px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #f0f0f0;font-size:13px}
th{color:#71717a;font-weight:600}.none{color:#a1a1aa;margin:2px 0 10px}.kpi{display:inline-block;margin-right:18px}.kpi b{font-size:18px;display:block}</style></head><body><div class="wrap">
<p class="meta">From: Cobra &lt;cobra@kantsy.com&gt; · ${esc(subject)}</p>
<h1>${all ? "Cobra daily digest, all teams" : `Cobra team digest: ${esc(d.teamName!)}`}</h1><p class="meta">${esc(fmtNy(d.since))} to ${esc(fmtNy(d.until))}</p>
<div><span class="kpi"><b>${d.runs.total}</b>runs</span><span class="kpi"><b>${d.runs.failed}</b>failed</span><span class="kpi"><b>${tok(d.costs.tokens)}</b>tokens</span><span class="kpi"><b>${usd(d.costs.costUsd)}</b>cost</span><span class="kpi"><b>${d.errors.stuck.length}</b>possibly stuck</span></div>
<h2>Usage</h2>${tbl(["Status", "Runs"], d.runs.byStatus.map((r) => [r.status, r.n]))}${tbl(["Engine", "Runs", "Simulated"], d.runs.byEngine.map((r) => [r.engine, r.n, r.simulated]))}${all ? tbl(["Team", "Runs", "Failed"], d.runs.byTeam.map((r) => [r.team, r.n, r.failed])) : ""}
<h2>Costs</h2>${all ? tbl(["Team", "Tokens", "Cost"], d.costs.byTeam.map((r) => [r.team, tok(r.tokens), usd(r.costUsd)])) : ""}${tbl(["Provider", "Model", "Tokens", "Cost", "Steps"], d.costs.byModel.map((u) => [u.provider, u.model ?? "", tok(u.tokens), usd(u.costUsd), u.steps]))}
<h2>Errors</h2>${tbl([...(all ? ["Team"] : []), "Engine", "Agent", "Failed"], d.errors.groups.map((g) => [...(all ? [g.team ?? ""] : []), g.engine, g.agent, g.n]))}
<p class="meta">Top failure messages</p>${tbl(["Count", "Message", "Latest run"], d.errors.top.map((t) => [t.n, t.message, t.lastRunId]))}
<p class="meta">Possibly stuck (still running after ${STUCK_AFTER_MS / 3_600_000} h)</p>${tbl([...(all ? ["Team"] : []), "Engine", "Agent", "Started", "Run"], d.errors.stuck.map((s) => [...(all ? [s.team ?? ""] : []), s.engine, s.agent, fmtNy(s.startedAt), s.id]))}
${d.extra.health || d.extra.updates ? `<h2>Service</h2>${d.extra.health ? `<p>${esc(d.extra.health)}</p>` : ""}${d.extra.updates ? `<p>4 AM tool updates: ${esc(d.extra.updates)}</p>` : ""}` : ""}
${(d.admin ?? []).map((sec) => `<h2>${esc(sec.title)}</h2><ul style="list-style:none;padding-left:0;margin:4px 0 10px">${sec.lines.map((l) => `<li${/^!!|FAILED/.test(l.trim()) ? ' style="color:#b91c1c;font-weight:600"' : ""}>${esc(l).replace(/^( +)/, (m) => "&nbsp;".repeat(m.length * 2))}</li>`).join("")}</ul>`).join("\n")}
</div></body></html>`;
}
