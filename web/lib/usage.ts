// Display-only usage tracking (migration 18): token counts and engine-reported cost per agent step.
// No budgets, caps or cost-based limits. Cost is stored only when the engine reports it (Claude Code's
// total_cost_usd); prices are never invented, so Codex rows have tokens and a NULL cost;
// OpenCode and Cursor (text output) get a row with NULL tokens and cost.
// Pure Node (no Next imports) so tests can drive it.
import type { DatabaseSync } from "node:sqlite";

type DB = DatabaseSync;
export type Usage = { provider: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; cost_usd: number | null; cost_source: "reported" | "estimated" | null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const add = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

/**
 * Line filter over an engine's JSON output (claude --output-format json, codex exec --json).
 * JSON lines are consumed (usage collected, human-readable text forwarded to the log); any other
 * line passes through unchanged. finish() returns the usage seen (null when none) and the final text.
 */
export function usageCollector(provider: string, model: string | null, log: (s: string) => void, o: { openRouter?: boolean } = {}) {
  let buf = "", text = "";
  let u: Usage | null = null;
  const base = (): Usage => u ?? (u = { provider, model, input_tokens: null, output_tokens: null, cached_tokens: null, cost_usd: null, cost_source: null });
  const line = (l: string) => {
    const t = l.trim();
    let j: Record<string, unknown> | null = null;
    if (t.startsWith("{")) { try { j = JSON.parse(t); } catch { j = null; } }
    if (!j || typeof j !== "object") { log(l + "\n"); return; }
    if (j.type === "result") { // Claude Code
      const us = (j.usage ?? {}) as Record<string, unknown>;
      const x = base();
      x.input_tokens = add(num(us.input_tokens), num(us.cache_creation_input_tokens));
      x.output_tokens = num(us.output_tokens);
      x.cached_tokens = num(us.cache_read_input_tokens);
      const cost = num(j.total_cost_usd);
      if (cost != null && !o.openRouter) { x.cost_usd = cost; x.cost_source = "reported"; }
      const models = j.modelUsage && typeof j.modelUsage === "object" ? Object.keys(j.modelUsage) : [];
      if (models.length && !o.openRouter) x.model = models.join(", ");
      if (typeof j.result === "string") { text = j.result; log(j.result + "\n"); }
      return;
    }
    if (j.type === "turn.completed" && j.usage) { // Codex: one per turn, summed
      const us = j.usage as Record<string, unknown>;
      const x = base();
      x.input_tokens = add(x.input_tokens, num(us.input_tokens));
      x.output_tokens = add(x.output_tokens, num(us.output_tokens));
      x.cached_tokens = add(x.cached_tokens, num(us.cached_input_tokens));
      return;
    }
    const item = j.item as Record<string, unknown> | undefined;
    if (j.type === "item.completed" && item) {
      if (item.type === "agent_message" && typeof item.text === "string") { text = item.text; log(item.text + "\n"); }
      else if (item.type === "command_execution" && typeof item.command === "string") log(`$ ${item.command}\n`);
    }
  };
  return {
    write(s: string) { buf += s; let i; while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } },
    finish(): { usage: Usage | null; text: string } { if (buf) { line(buf); buf = ""; } return { usage: u, text }; },
    /** Usage seen, or a row with null tokens/cost when the engine reported none (OpenCode, Cursor text output). */
    orNull(): Usage { return base(); },
  };
}

/** Stores one usage row. key is the runner's run key: the run id, or `<run id>-<step id>` for multi-agent workflows. */
export function recordUsage(db: DB, key: string, u: Usage, at = Date.now()): void {
  const run = db.prepare("SELECT id FROM runs WHERE id = ? OR ? LIKE id || '-%' ORDER BY length(id) DESC LIMIT 1").get(key, key) as { id: string } | undefined;
  if (!run) return;
  const step = key.length > run.id.length ? key.slice(run.id.length + 1) : null;
  db.prepare("INSERT INTO run_usage (run_id, step_id, provider, model, input_tokens, output_tokens, cached_tokens, cost_usd, cost_source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(run.id, step, u.provider, u.model, u.input_tokens, u.output_tokens, u.cached_tokens, u.cost_usd, u.cost_source, at);
}

export const RANGES = { "7d": 7, "30d": 30, all: null } as const;
export type Range = keyof typeof RANGES;
export const parseRange = (v: unknown): Range => (v === "7d" || v === "30d" || v === "all" ? v : "30d");
const since = (r: Range, now: number) => (RANGES[r] == null ? 0 : now - RANGES[r]! * 86_400_000);
const plain = <T>(rows: unknown[]): T[] => rows.map((r) => ({ ...(r as object) }) as T);

// sum() of all-NULL is NULL, so "no tokens/cost reported" stays distinguishable from 0.
const SUMS = "sum(u.input_tokens) input_tokens, sum(u.output_tokens) output_tokens, sum(u.cached_tokens) cached_tokens, sum(u.cost_usd) cost_usd, count(u.id) steps";
export type Sums = { input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; cost_usd: number | null; steps: number };

/** The viewer's scope: system admins (role admin) see every team (null); everyone else only their own team. */
export const usageScope = (u: { role: string; tenantId: number }): number | null => (u.role === "admin" ? null : u.tenantId);

/** Usage report. tenantId null = all teams (system admin only, via usageScope); otherwise every query is
 *  filtered to that team in SQL. Runs in range are counted by started_at (UTC ms). */
export function usageReport(db: DB, range: Range, opts: { now?: number; page?: number; pageSize?: number; tenantId?: number | null } = {}) {
  const from = since(range, opts.now ?? Date.now());
  const tid = opts.tenantId ?? null;
  const T = "(? IS NULL OR r.tenant_id = ?)";
  const pageSize = opts.pageSize ?? 25;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const totals = { ...(db.prepare(`SELECT ${SUMS}, count(DISTINCT u.run_id) runs_with_usage, (SELECT count(*) FROM runs r WHERE r.started_at >= ? AND ${T}) runs FROM run_usage u JOIN runs r ON r.id = u.run_id WHERE r.started_at >= ? AND ${T}`).get(from, tid, tid, from, tid, tid) as object) } as Sums & { runs: number; runs_with_usage: number };
  const runCount = totals.runs;
  const runs = plain<Sums & { id: string; workflow: string | null; tenant: string; started_at: number; status: string | null; providers: string | null }>(db.prepare(`
    SELECT r.id, r.workflow, t.name tenant, r.started_at, r.status, group_concat(DISTINCT u.provider) providers, ${SUMS}
    FROM runs r JOIN tenants t ON t.id = r.tenant_id LEFT JOIN run_usage u ON u.run_id = r.id
    WHERE r.started_at >= ? AND ${T} GROUP BY r.id ORDER BY r.started_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(from, tid, tid, pageSize, (page - 1) * pageSize));
  const teams = plain<Sums & { tenant: string; runs: number }>(db.prepare(`
    SELECT t.name tenant, count(DISTINCT r.id) runs, ${SUMS}
    FROM runs r JOIN tenants t ON t.id = r.tenant_id LEFT JOIN run_usage u ON u.run_id = r.id
    WHERE r.started_at >= ? AND ${T} GROUP BY t.id ORDER BY t.name`).all(from, tid, tid));
  const providers = plain<Sums & { provider: string; model: string | null; runs: number }>(db.prepare(`
    SELECT u.provider, u.model, count(DISTINCT u.run_id) runs, ${SUMS}
    FROM run_usage u JOIN runs r ON r.id = u.run_id
    WHERE r.started_at >= ? AND ${T} GROUP BY u.provider, u.model ORDER BY u.provider, u.model`).all(from, tid, tid));
  return { range, scope: tid, page, pageSize, pages: Math.max(1, Math.ceil(runCount / pageSize)), totals, runs, teams, providers };
}
