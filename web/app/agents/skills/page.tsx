import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { SkillsList, type SkillRow } from "@/components/skills";
import { actor, getDb } from "@/lib/workflows/server";
import { list } from "@/lib/skills/service";
import { canEdit, getSkill, type Actor } from "@/lib/skills/store";
import { AgentsTabs } from "@/components/agents-tabs";

export const metadata = { title: "Skills · Agents · Cobra" };

type Row = { id: number; name: string; kind: string; version: number; description: string; team: string; steps: number };

/** Agents / Skills: a sibling of Agents / Agents (same header, toggle, count row, table and empty state). */
export default function SkillsPage() {
  return (
    <div className="space-y-6">
      <header><h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-sm text-muted">Step-by-step instructions an agent can follow. Everyone on your team can run every skill.</p></header>
      <AgentsTabs active="skills" />
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><AuthGate>{(su) => <Body u={actor(su)} />}</AuthGate></Suspense>
    </div>
  );
}

function Body({ u }: { u: Actor }) {
  const db = getDb();
  const rows: SkillRow[] = ((list(db, u).body as { skills: Row[] }).skills).map((r) => {
    const s = getSkill(db, u, r.id);
    return { id: r.id, name: r.name, kind: r.kind, version: r.version, description: r.description, steps: r.steps, canEdit: !!s && canEdit(db, u, s) };
  });
  return <SkillsList rows={rows} />;
}
