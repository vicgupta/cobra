"use client";

// Run history timeline (read-only audit trail). Data comes from the server (lib/workflows/run-history.ts);
// filter and paging are plain links (?runs=&page=) so the server re-applies the scoping on every view.
import Link from "next/link";
import { StatusBadge } from "./workflows";
import { Badge } from "./ui";
import type { HistoryPage } from "@/lib/workflows/run-history";

/** Stored UTC (ms); rendered in the viewer's local time zone by the browser. */
export function LocalTime({ ms }: { ms: number }) {
  const d = new Date(ms);
  return <time dateTime={d.toISOString()} title={`${d.toISOString().replace("T", " ").slice(0, 19)} UTC`} suppressHydrationWarning>{d.toLocaleString()}</time>;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m ${s % 60}s`;
}

const FILTER_LABEL = { all: "All", passed: "Passed", failed: "Failed", running: "Running" } as const;
const ENGINE_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

export function RunHistory({ data, base }: { data: HistoryPage; base: string }) {
  const href = (f: string, p = 1) => `${base}?${new URLSearchParams({ ...(f !== "all" ? { runs: f } : {}), ...(p > 1 ? { page: String(p) } : {}) })}#run-history`;
  const admin = data.scope === "all-teams";
  return (
    <div id="run-history" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm" role="tablist" aria-label="Filter runs by status">
        {(Object.keys(FILTER_LABEL) as Array<keyof typeof FILTER_LABEL>).map((f) => (
          <Link key={f} role="tab" aria-selected={data.filter === f} href={href(f)}
            className={`rounded-md border px-2.5 py-1 ${data.filter === f ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-border-strong text-fg-soft hover:bg-surface-2"}`}>
            {FILTER_LABEL[f]} <span className="text-xs text-subtle">{data.counts[f]}</span>
          </Link>
        ))}
        {admin && <Badge tone="violet">all teams (system admin)</Badge>}
      </div>
      {data.runs.length === 0 ? <p className="text-sm text-subtle">{data.filter === "all" ? "No runs yet." : "No runs match this filter."}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-subtle"><tr>
              <th className="py-1 pr-3 font-normal">Run</th>{admin && <th className="py-1 pr-3 font-normal">Team</th>}<th className="py-1 pr-3 font-normal">Status</th>
              <th className="py-1 pr-3 font-normal">Triggered by</th><th className="py-1 pr-3 font-normal">Started (your time)</th><th className="py-1 pr-3 font-normal">Duration</th>
              <th className="py-1 pr-3 font-normal">Mode / engine</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {data.runs.map((r) => (
                <tr key={r.id} className="align-top" data-run-id={r.id}>
                  <td className="py-1.5 pr-3 font-mono text-xs">{r.canOpen ? <Link className="text-success hover:underline" href={`/runs/${encodeURIComponent(r.id)}`}>{r.id}</Link> : r.id}</td>
                  {admin && <td className="py-1.5 pr-3 text-xs">{r.team}</td>}
                  <td className="py-1.5 pr-3"><StatusBadge status={r.status} />{r.reason && <p className="mt-1 max-w-xs text-xs text-danger">{r.reason}</p>}</td>
                  <td className="py-1.5 pr-3 text-xs">{r.triggeredBy}</td>
                  <td className="py-1.5 pr-3 text-xs text-muted"><LocalTime ms={r.startedAt} /></td>
                  <td className="py-1.5 pr-3 text-xs text-muted">{r.status === "running" ? "running…" : formatDuration(r.durationMs)}</td>
                  <td className="py-1.5 pr-3 text-xs text-muted">{[r.mode, r.engine ? ENGINE_LABEL[r.engine] ?? r.engine : null].filter(Boolean).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-subtle">
        <span>{data.total} run{data.total === 1 ? "" : "s"} · page {data.page} of {data.pages}</span>
        {data.page > 1 && <Link className="text-success hover:underline" href={href(data.filter, data.page - 1)}>← Newer</Link>}
        {data.page < data.pages && <Link className="text-success hover:underline" href={href(data.filter, data.page + 1)}>Older →</Link>}
      </div>
    </div>
  );
}
