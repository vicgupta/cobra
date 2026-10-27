// In-app rendering of a digest (lib/digest.ts). Server component, display only.
import type { Digest } from "@/lib/digest";
import { fmtNy, STUCK_AFTER_MS } from "@/lib/digest";

const usd = (c: number | null) => (c == null ? "n/a" : `$${c.toFixed(2)}`);
const tok = (n: number) => n.toLocaleString("en-US");

function T({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  if (!rows.length) return <p className="text-xs text-subtle">None</p>;
  return (
    <table className="w-full text-sm"><thead><tr className="text-left text-xs text-subtle">{head.map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-border">{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="py-1 pr-3 align-top">{c}</td>)}</tr>)}</tbody></table>
  );
}

export function DigestView({ d }: { d: Digest }) {
  const all = d.scope.kind === "all";
  const kpi = (v: string | number, l: string) => <div className="rounded-md border border-border px-3 py-2"><div className="text-lg font-semibold">{v}</div><div className="text-xs text-subtle">{l}</div></div>;
  return (
    <div className="space-y-5" data-digest={all ? "all" : "team"}>
      <p className="text-xs text-subtle">{fmtNy(d.since)} to {fmtNy(d.until)}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{kpi(d.runs.total, "runs")}{kpi(d.runs.failed, "failed")}{kpi(tok(d.costs.tokens), "tokens")}{kpi(usd(d.costs.costUsd), "cost (engine-reported)")}{kpi(d.errors.stuck.length, "possibly stuck")}</div>
      <section className="space-y-2"><h3 className="text-sm font-semibold">Usage</h3>
        <div className="grid gap-4 sm:grid-cols-2"><T head={["Status", "Runs"]} rows={d.runs.byStatus.map((r) => [r.status, r.n])} /><T head={["Engine", "Runs", "Simulated"]} rows={d.runs.byEngine.map((r) => [r.engine, r.n, r.simulated])} /></div>
        {all && <T head={["Team", "Runs", "Failed"]} rows={d.runs.byTeam.map((r) => [r.team, r.n, r.failed])} />}
      </section>
      <section className="space-y-2"><h3 className="text-sm font-semibold">Costs</h3>
        {all && <T head={["Team", "Tokens", "Cost"]} rows={d.costs.byTeam.map((r) => [r.team, tok(r.tokens), usd(r.costUsd)])} />}
        <T head={["Provider", "Model", "Tokens", "Cost", "Steps"]} rows={d.costs.byModel.map((u) => [u.provider, u.model ?? "", tok(u.tokens), usd(u.costUsd), u.steps])} />
      </section>
      <section className="space-y-2"><h3 className="text-sm font-semibold">Errors</h3>
        <T head={[...(all ? ["Team"] : []), "Engine", "Agent", "Failed"]} rows={d.errors.groups.map((g) => [...(all ? [g.team ?? ""] : []), g.engine, g.agent, g.n])} />
        <p className="text-xs text-subtle">Top failure messages</p>
        <T head={["Count", "Message", "Latest run"]} rows={d.errors.top.map((t) => [t.n, t.message, t.lastRunId])} />
        <p className="text-xs text-subtle">Possibly stuck (still running after {STUCK_AFTER_MS / 3_600_000} h)</p>
        <T head={[...(all ? ["Team"] : []), "Engine", "Agent", "Started", "Run"]} rows={d.errors.stuck.map((s) => [...(all ? [s.team ?? ""] : []), s.engine, s.agent, fmtNy(s.startedAt), s.id])} />
      </section>
      {(d.extra.health || d.extra.updates) && <section className="space-y-1 text-xs text-muted"><h3 className="text-sm font-semibold text-fg">Service</h3>{d.extra.health && <p>{d.extra.health}</p>}{d.extra.updates && <p>4 AM tool updates: {d.extra.updates}</p>}</section>}
    </div>
  );
}
