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
      <summary className="cursor-pointer list-none rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">Status: {LABEL[status]} ▾</summary>
      <ul className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-zinc-700 bg-zinc-900 py-1 text-sm shadow-lg">
        {STATUS_FILTERS.map((f) => (
          <li key={f}><Link href={f === "all" ? "/workflows" : `/workflows?status=${f}`} aria-current={f === status ? "true" : undefined}
            className={`flex justify-between px-3 py-1.5 hover:bg-zinc-800 ${f === status ? "text-emerald-300" : "text-zinc-200"}`}>
            <span>{LABEL[f]}</span><span className="tabular-nums text-zinc-500">{counts[f]}</span></Link></li>
        ))}
      </ul>
    </details>
  );
}

function List({ user, status }: { user: SessionUser; status: StatusFilter }) {
  const all = (listWorkflowsFor(getDb(), actor(user)).body as Row[]).filter((r) => !r.template && r.origin !== "template");
  const rows = filterByStatus(all, status), counts = statusCounts(all);
  return (
    <Card title="Workflows" subtitle="Built-ins from the repo and your workspace's workflows" action={<div className="flex items-center gap-2"><StatusMenu status={status} counts={counts} /><Link href="/workflows/new" className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">New (template + repo)</Link></div>}>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500"><tr><th className="py-2">Name</th><th>Source</th><th>Owner</th><th>Approvers</th><th>Status</th></tr></thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map((r) => (
            <tr key={`${r.origin}:${r.name}`}>
              <td className="py-2"><Link className="text-emerald-300 hover:underline" href={`/workflows/${encodeURIComponent(r.name)}`}>{r.name}</Link>{r.description && <div className="text-xs text-zinc-500">{r.description}</div>}</td>
              <td className="text-xs text-zinc-400">{r.origin === "repo" ? "built-in" : "workspace"}</td>
              <td className="text-xs">{r.owner ?? "—"}</td>
              <td className="text-xs">{r.approvers?.join(", ") ?? "—"}</td>
              <td>{r.errors ? <span className="text-xs text-rose-300">invalid: {r.errors[0]}</span> : <StatusBadge status={r.approval?.status} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="py-4 text-sm text-zinc-500">{status === "all" ? "No workflows" : `No ${status} workflows`}</p>}
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
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <Body searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
