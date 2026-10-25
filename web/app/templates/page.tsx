import Link from "next/link";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Badge, Card } from "@/components/ui";
import { CopyButton } from "@/components/workflows";
import { getDb } from "@/lib/workflows/server";
import { instancesOf, listAll } from "@/lib/workflows/store";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Templates · Cobra" };

function Templates({ user }: { user: SessionUser }) {
  const db = getDb();
  const all = listAll(db, user.tenantId).filter((l) => l.loaded?.workflow.template);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Link href="/workflows/new?kind=template" className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">New workspace template</Link>
      </div>
      {all.map(({ loaded: t }) => t && (
        <Card key={`${t.origin}:${t.workflow.name}`}
          title={<span className="flex items-center gap-2">{t.workflow.name} {t.origin === "template" ? <Badge tone="violet">system · read-only</Badge> : <Badge tone="blue">workspace</Badge>}</span>}
          subtitle={t.workflow.description}
          action={<div className="flex gap-2"><CopyButton text={t.source} />
            <Link href={`/workflows/new?template=${encodeURIComponent(t.workflow.name)}`} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">Use template</Link>
            <Link href={`/workflows/${encodeURIComponent(t.workflow.name)}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">Details</Link>
            {t.origin === "tenant" && <Link href={`/workflows/${encodeURIComponent(t.workflow.name)}/edit`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">Edit</Link>}</div>}>
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">
            {t.workflow.steps.map((s) => <li key={s.id}><span className="font-mono text-xs">{s.id}</span> <span className="text-zinc-500">({s.uses})</span> {s.name}</li>)}
          </ol>
          {(() => { const inst = instancesOf(db, user.tenantId, t.workflow.name); return (
            <p className="mb-3 text-xs text-zinc-400">Instances: {inst.length === 0 ? "none yet" : inst.map((i, k) => <span key={i.name}>{k > 0 && ", "}<Link className="text-emerald-300 hover:underline" href={`/workflows/${encodeURIComponent(i.name)}`}>{i.name}</Link></span>)}</p>); })()}
          <details><summary className="cursor-pointer text-xs text-zinc-400">View YAML</summary>
            <pre className="mt-2 max-h-[32rem] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs">{t.source}</pre></details>
        </Card>
      ))}
    </div>
  );
}

export default function TemplatesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="text-sm text-zinc-400">Starting points for workflows. Copies are yours to edit and need approval before they run.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <AuthGate>{(u) => <Templates user={u} />}</AuthGate>
      </Suspense>
    </div>
  );
}
