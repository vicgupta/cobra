import Link from "next/link";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { StatusBadge } from "@/components/workflows";
import { actor, getDb } from "@/lib/workflows/server";
import { listWorkflowsFor } from "@/lib/workflows/service";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Workflows · Cobra" };

type Row = { name: string; origin: string; template?: boolean; owner?: string; approvers?: string[]; approval?: { status: string }; description?: string; errors?: string[] };

function List({ user }: { user: SessionUser }) {
  const rows = (listWorkflowsFor(getDb(), actor(user)).body as Row[]).filter((r) => !r.template && r.origin !== "template");
  return (
    <Card title="Workflows" subtitle="Built-ins from the repo and your workspace's workflows" action={<Link href="/workflows/new" className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">New (template + repo)</Link>}>
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
    </Card>
  );
}

export default function WorkflowsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <AuthGate>{(u) => <List user={u} />}</AuthGate>
      </Suspense>
    </div>
  );
}
