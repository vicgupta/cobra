import Link from "next/link";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { RunLog } from "@/components/workflows";
import { actor, getDb } from "@/lib/workflows/server";
import { runDetailFor } from "@/lib/workflows/service";
import type { RunDetail } from "@/lib/workflows/runner";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Run log · Cobra" };

function Log({ user, id }: { user: SessionUser; id: string }) {
  const r = runDetailFor(getDb(), actor(user), id);
  if (r.status !== 200) return <p className="text-sm text-muted">Run not found, or you don&apos;t have access (runs are visible to members of their own workspace).</p>;
  const d = r.body as RunDetail;
  return (
    <div className="space-y-4">
      {d.injectedLessons?.length > 0 && (
        <section data-testid="injected-lessons" className="rounded-lg border border-border bg-surface-2/40 p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-subtle">Team lessons injected ({d.injectedLessons.length})</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {d.injectedLessons.map((l) => <li key={l.id}><Link href={`/agents/lessons?lesson=${l.id}`} className="text-accent hover:underline">L{l.id}</Link> {l.title}{l.status !== "approved" && <span className="ml-2 text-xs text-subtle">(now {l.status})</span>}</li>)}
          </ul>
        </section>
      )}
      <RunLog initial={d} />
    </div>
  );
}

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Card title={<span className="font-mono">{id}</span>} subtitle="Step log (read-only; secrets redacted)"><AuthGate>{(u) => <Log user={u} id={id} />}</AuthGate></Card>;
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Run</h1>
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><Body params={params} /></Suspense>
    </div>
  );
}
