// Usage panel (display only; no budgets or limits).
import Link from "next/link";
import type { ReactNode } from "react";
import { getDb } from "@/lib/db";
import { usageReport, type Range, type Sums } from "@/lib/usage";
import { Badge, Card, Stat, type Tone } from "@/components/ui";

const dt = (t: number | null | undefined) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const statusTone = (s: string | null): Tone => (s === "succeeded" ? "green" : s === "failed" ? "red" : s === "running" || s === "queued" ? "blue" : "gray");
function Table({ head, rows, empty = "Nothing yet" }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="text-sm text-subtle">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-subtle"><tr>{head.map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top text-fg-soft">{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

const fmtN = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US"));
const fmtUsd = (v: number | null | undefined) => (v == null ? "—" : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const sumCells = (s: Sums) => (s.steps ? [fmtN(s.input_tokens), fmtN(s.output_tokens), fmtN(s.cached_tokens), fmtUsd(s.cost_usd)] : [<span key="nd" className="text-subtle">no data</span>, "", "", ""]);
const SUM_HEAD = ["Input tokens", "Output tokens", "Cached tokens", "Cost (reported)"];

/** Shared by Admin > Usage (tenantId null: all teams) and Settings > Usage (the viewer's team via usageScope).
 *  Scoping happens in the SQL; callers never pass a team id from the request. */
export function UsageView({ range, page, tenantId, base }: { range: Range; page: number; tenantId: number | null; base: string }) {
  const u = usageReport(getDb(), range, { page, tenantId });
  const href = (r: Range, p = 1) => `${base}${base.includes("?") ? "&" : "?"}range=${r}${p > 1 ? `&page=${p}` : ""}`;
  const t = u.totals;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Range:</span>
        {(["7d", "30d", "all"] as const).map((r) => <Link key={r} href={href(r)} className={`rounded-md px-3 py-1 ${r === range ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg"}`}>{r === "all" ? "All time" : `Last ${r}`}</Link>)}
        <span className="text-xs text-subtle">Display only: no budgets or limits. Cost is shown only when the engine reports it (Claude Code); otherwise —. Runs counted by start time (UTC).</span>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Input tokens" value={fmtN(t.input_tokens)} hint="incl. cache writes" />
        <Stat label="Output tokens" value={fmtN(t.output_tokens)} />
        <Stat label="Cached tokens" value={fmtN(t.cached_tokens)} hint="cache reads" />
        <Stat label="Reported cost" value={fmtUsd(t.cost_usd)} />
        <Stat label="Runs with usage" value={`${t.runs_with_usage} / ${t.runs}`} hint={`${t.steps} agent steps`} />
      </div>
      <Card title="By run" subtitle={`Newest first · page ${u.page} of ${u.pages}`}>
        <Table head={["Started", "Run", "Workflow", "Team", "Status", "Providers", ...SUM_HEAD]} empty="No runs in this range"
          rows={u.runs.map((r) => [dt(r.started_at), <Link key="l" href={`/runs/${r.id}`} className="text-info hover:underline"><code className="text-xs">{r.id.slice(0, 12)}</code></Link>, r.workflow ?? "—", r.tenant, <Badge key="s" tone={statusTone(r.status)}>{r.status ?? "legacy"}</Badge>, r.providers ?? "—", ...sumCells(r)])} />
        {u.pages > 1 && <div className="mt-3 flex gap-3 text-sm">
          {u.page > 1 && <Link href={href(range, u.page - 1)} className="text-info hover:underline">← Newer</Link>}
          {u.page < u.pages && <Link href={href(range, u.page + 1)} className="text-info hover:underline">Older →</Link>}
        </div>}
      </Card>
      <Card title="By team" subtitle={tenantId == null ? "All teams" : "Your team"}><Table head={["Team", "Runs", "Agent steps", ...SUM_HEAD]} empty="No runs in this range"
        rows={u.teams.map((x) => [x.tenant, x.runs, x.steps, ...sumCells(x)])} /></Card>
      <Card title="By provider / model"><Table head={["Provider", "Model", "Runs", "Agent steps", ...SUM_HEAD]} empty="No usage recorded in this range"
        rows={u.providers.map((x) => [x.provider, x.model ?? "default", x.runs, x.steps, ...sumCells(x)])} /></Card>
    </div>
  );
}
