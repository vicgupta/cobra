import Link from "next/link";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { StatusBadge } from "@/components/workflows";
import { actor, getDb } from "@/lib/workflows/server";
import { filterByStatus, listWorkflowsFor, parseStatusFilter, statusCounts, STATUS_FILTERS, type StatusFilter } from "@/lib/workflows/service";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Workflows · Cobra" };

type Row = { name: string; origin: string; template?: boolean; owner?: string; approvers?: string[]; approval?: { status: string }; description?: string; errors?: string[] };

const LABEL: Record<StatusFilter, string> = { all: "All", approved: "Approved", pending: "Pending", rejected: "Rejected" };

/** Status filter: a button opening a dropdown of links (?status=), so the choice survives reloads and links. */
function StatusMenu({ status, counts }: { status: StatusFilter; counts: Record<StatusFilter, number> }) {
  return (
    <details className="relative" data-testid="status-filter">
      <summary className="cursor-pointer list-none rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2">Status: {LABEL[status]} ▾</summary>
      <ul className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-border-strong bg-surface py-1 text-sm shadow-lg">
        {STATUS_FILTERS.map((f) => (
          <li key={f}><Link href={f === "all" ? "/workflows" : `/workflows?status=${f}`} aria-current={f === status ? "true" : undefined}
            className={`flex justify-between px-3 py-1.5 hover:bg-surface-2 ${f === status ? "text-success" : "text-fg-soft"}`}>
            <span>{LABEL[f]}</span><span className="tabular-nums text-subtle">{counts[f]}</span></Link></li>
        ))}
      </ul>
    </details>
  );
}

function List({ user, status }: { user: SessionUser; status: StatusFilter }) {
  const all = (listWorkflowsFor(getDb(), actor(user)).body as Row[]).filter((r) => !r.template && r.origin !== "template");
  const rows = filterByStatus(all, status), counts = statusCounts(all);
  return (
    <Card title="Workflows" subtitle="Built-ins from the repo and your workspace's workflows" action={<div className="flex items-center gap-2"><StatusMenu status={status} counts={counts} /><Link href="/workflows/new" className="rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90">New (template + repo)</Link></div>}>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-subtle"><tr><th className="py-2">Name</th><th>Source</th><th>Owner</th><th>Approvers</th><th>Status</th></tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={`${r.origin}:${r.name}`}>
              <td className="py-2"><Link className="text-success hover:underline" href={`/workflows/${encodeURIComponent(r.name)}`}>{r.name}</Link>{r.description && <div className="text-xs text-subtle">{r.description}</div>}</td>
              <td className="text-xs text-muted">{r.origin === "repo" ? "built-in" : "workspace"}</td>
              <td className="text-xs">{r.owner ?? "—"}</td>
              <td className="text-xs">{r.approvers?.join(", ") ?? "—"}</td>
              <td>{r.errors ? <span className="text-xs text-danger">invalid: {r.errors[0]}</span> : <StatusBadge status={r.approval?.status} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="py-4 text-sm text-subtle">{status === "all" ? "No workflows" : `No ${status} workflows`}</p>}
    </Card>
  );
}

async function Body({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  const status = parseStatusFilter((await searchParams).status);
  return <AuthGate>{(u) => <List user={u} status={status} />}</AuthGate>;
}

export default function WorkflowsPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}>
        <Body searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
