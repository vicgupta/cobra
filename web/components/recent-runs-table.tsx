"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ariaSort, DEFAULT_SORT, durationMs, formatDuration, nextSort, relativeTime, shortId, sortRuns, statusTone,
  type RunRow, type SortKey, type StatusTone } from "@/lib/runs-table";

// Theme-agnostic: tinted fills + semantic text tokens (work under :root/.dark and .light alike).
const PILL: Record<StatusTone, string> = {
  success: "bg-emerald-500/15 text-success ring-emerald-500/30",
  failure: "bg-red-500/15 text-danger ring-red-500/35",
  running: "bg-slate-800 text-slate-50 ring-slate-500/50",
  pending: "bg-surface-2 text-muted ring-transparent",
  cancelled: "bg-transparent text-subtle ring-border-strong",
  neutral: "bg-surface-2 text-muted ring-transparent",
};

export function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PILL[tone]}`}>
      {tone === "running" && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-300 motion-safe:animate-[pulse_2.4s_ease-in-out_infinite]" />}
      {status.replace(/_/g, " ")}
    </span>
  );
}

const COLS: Array<{ key: SortKey; label: string; className?: string }> = [
  { key: "id", label: "Run ID" },
  { key: "name", label: "Agent / Skill" },
  { key: "status", label: "Status" },
  { key: "startedAt", label: "Started" },
  { key: "duration", label: "Duration", className: "text-right" },
  { key: "triggeredBy", label: "Triggered by" },
];

export function RecentRunsTable({ runs, now }: { runs: RunRow[]; now: number }) {
  const [sort, setSort] = useState(DEFAULT_SORT);
  const rows = useMemo(() => sortRuns(runs, sort.key, sort.dir), [runs, sort]);
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-subtle">
            {COLS.map((c) => {
              const a = ariaSort(sort, c.key);
              return (
                <th key={c.key} scope="col" aria-sort={a} className={`h-9 px-2 font-medium ${c.className ?? ""}`}>
                  <button type="button" onClick={() => setSort(nextSort(sort, c.key))}
                    className={`inline-flex items-center gap-1 rounded hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${a !== "none" ? "text-fg" : ""}`}>
                    {c.label}
                    <span aria-hidden className={`text-[10px] ${a === "none" ? "opacity-0" : ""}`}>{a === "ascending" ? "▲" : "▼"}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id} className="h-9 hover:bg-surface-2/60">
              <td className="px-2"><Link href={`/runs/${r.id}`} title={r.id} className="font-mono text-xs tabular-nums text-accent hover:underline">{shortId(r.id)}</Link></td>
              <td className="max-w-[16rem] truncate px-2 font-medium" title={r.name}>
                {r.name}{r.kind !== "agent" && <span className="ml-1.5 text-xs font-normal text-subtle">{r.kind === "legacy" ? "legacy test" : r.kind}</span>}
              </td>
              <td className="px-2"><StatusPill status={r.status} /></td>
              <td className="whitespace-nowrap px-2 tabular-nums text-muted"><time dateTime={new Date(r.startedAt).toISOString()} title={new Date(r.startedAt).toLocaleString()} suppressHydrationWarning>{relativeTime(r.startedAt, now)}</time></td>
              <td className="whitespace-nowrap px-2 text-right tabular-nums text-muted">{formatDuration(durationMs(r))}</td>
              <td className="max-w-[12rem] truncate px-2 text-muted">{r.triggeredBy ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
