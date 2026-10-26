// Server-rendered pieces for the issues and PR pages.
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card } from "./ui";
import type { AuditRow } from "@/lib/collab";
import type { GhComment } from "@/lib/github-api";

const dt = (t: number | string | null) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const LABEL: Record<string, string> = { issue_create: "created issue", agent_issue: "agent wrote issue", pr_create: "opened PR", comment: "commented", merge: "merged" };

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <Card title="Audit" subtitle="Who did each step in Cobra.">
      {rows.length === 0 ? <p className="text-sm text-subtle">Nothing recorded yet.</p> : (
        <table className="w-full text-left text-sm"><thead className="text-xs text-subtle"><tr><th className="py-1">When</th><th>Who</th><th>Action</th><th>Run</th><th>Detail</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="border-t border-border"><td className="py-1 text-xs text-muted">{dt(r.at)}</td><td>{r.actorEmail}</td><td><Badge tone={r.action === "merge" ? "violet" : "gray"}>{LABEL[r.action] ?? r.action}</Badge></td>
            <td>{r.runId ? <Link className="font-mono text-xs underline" href={`/runs/${r.runId}`}>{r.runId}</Link> : "—"}</td><td className="text-xs text-muted">{r.detail}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

export function Comments({ title, items }: { title: string; items: Array<GhComment & { extra?: ReactNode }> }) {
  return (
    <Card title={title}>
      {items.length === 0 ? <p className="text-sm text-subtle">None yet.</p> : <ul className="space-y-3">{items.map((c) => (
        <li key={c.id} className="rounded-md border border-border p-3"><p className="mb-1 text-xs text-subtle">{c.user?.login ?? "?"} · {dt(c.created_at)}{c.path ? ` · ${c.path}${c.line ? `:${c.line}` : ""}` : ""}{c.extra}</p>
          <pre className="whitespace-pre-wrap font-sans text-sm text-fg-soft">{c.body}</pre></li>
      ))}</ul>}
    </Card>
  );
}

export const ghDate = dt;
export function GhError({ e }: { e: unknown }) {
  return <p role="alert" className="rounded-md border border-danger-border bg-danger-soft p-3 text-sm text-danger">{e instanceof Error ? e.message : String(e)}</p>;
}
