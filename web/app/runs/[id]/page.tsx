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
  if (r.status !== 200) return <p className="text-sm text-zinc-400">Run not found, or you don&apos;t have access (runs are visible to members of their own workspace).</p>;
  return <RunLog initial={r.body as RunDetail} />;
}

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Card title={<span className="font-mono">{id}</span>} subtitle="Step log (read-only; secrets redacted)"><AuthGate>{(u) => <Log user={u} id={id} />}</AuthGate></Card>;
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Run</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><Body params={params} /></Suspense>
    </div>
  );
}
