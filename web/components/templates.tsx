// Workspace templates list. Moved unchanged from app/templates/page.tsx in Job 16; /templates now redirects to /settings/templates.
import Link from "next/link";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Badge, Card } from "@/components/ui";
import { CopyButton } from "@/components/workflows";
import { getDb } from "@/lib/workflows/server";
import { instancesOf, listAll } from "@/lib/workflows/store";
import type { SessionUser } from "@/lib/auth/sessions";

export function Templates({ user }: { user: SessionUser }) {
  const db = getDb();
  const all = listAll(db, user.tenantId).filter((l) => l.loaded?.workflow.template);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Link href="/workflows/new?kind=template" className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:bg-surface-2">New workspace template</Link>
      </div>
      {all.map(({ loaded: t }) => t && (
        <Card key={`${t.origin}:${t.workflow.name}`}
          title={<span className="flex items-center gap-2">{t.workflow.name} {t.origin === "template" ? <Badge tone="violet">system · read-only</Badge> : <Badge tone="blue">workspace</Badge>}</span>}
          subtitle={t.workflow.description}
          action={<div className="flex gap-2"><CopyButton text={t.source} />
            <Link href={`/workflows/new?template=${encodeURIComponent(t.workflow.name)}`} className="rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90">Use template</Link>
            <Link href={`/workflows/${encodeURIComponent(t.workflow.name)}`} className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:bg-surface-2">Details</Link>
            {t.origin === "tenant" && <Link href={`/workflows/${encodeURIComponent(t.workflow.name)}/edit`} className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:bg-surface-2">Edit</Link>}</div>}>
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">
            {t.workflow.steps.map((s) => <li key={s.id}><span className="font-mono text-xs">{s.id}</span> <span className="text-subtle">({s.uses})</span> {s.name}</li>)}
          </ol>
          {(() => { const inst = instancesOf(db, user.tenantId, t.workflow.name); return (
            <p className="mb-3 text-xs text-muted">Instances: {inst.length === 0 ? "none yet" : inst.map((i, k) => <span key={i.name}>{k > 0 && ", "}<Link className="text-success hover:underline" href={`/workflows/${encodeURIComponent(i.name)}`}>{i.name}</Link></span>)}</p>); })()}
          <details><summary className="cursor-pointer text-xs text-muted">View YAML</summary>
            <pre className="mt-2 max-h-[32rem] overflow-auto rounded-md bg-bg p-3 font-mono text-xs">{t.source}</pre></details>
        </Card>
      ))}
    </div>
  );
}

/** The Templates view (header, auth, list). Rendered at /settings/templates and in Admin > Settings > Templates. */
export function TemplatesView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="text-sm text-muted">Starting points for workflows. Copies are yours to edit and need approval before they run.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}>
        <AuthGate>{(u) => <Templates user={u} />}</AuthGate>
      </Suspense>
    </div>
  );
}
