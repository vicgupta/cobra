import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { SkillsList, type SkillRow } from "@/components/skills";
import { actor, getDb } from "@/lib/workflows/server";
import { list } from "@/lib/skills/service";
import { canEdit, getSkill, type Actor } from "@/lib/skills/store";
import { loadTextSkills } from "@/lib/text-skills";
import { TextSkillRun } from "@/components/text-skills";
import { listTeamRepos } from "@/lib/repos";
import { ENGINES } from "@/lib/engines";
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
  const text = loadTextSkills();
  return (
    <div className="space-y-8">
    <SkillsList rows={rows} />
    {text.length > 0 && <section className="space-y-3" aria-labelledby="text-skills-h">
      <h2 id="text-skills-h" className="text-base font-semibold">Built-in skills</h2>
      <div className="grid gap-3 md:grid-cols-2" data-testid="text-skills">{text.map((t) => (
        <div key={t.id} className="rounded-xl border border-border bg-surface/60 p-4 shadow-sm" data-text-skill={t.id}>
          <div className="text-sm font-medium">{t.id}</div>
          <p className="mt-1 text-xs text-subtle">Say “{t.trigger}” to use it</p>
          <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-fg-soft" data-skill-text>{t.text}</p>
          <TextSkillRun skill={t.id} repos={listTeamRepos(getDb(), u.tenantId).map((r) => r.repo)} engines={[...ENGINES]} />
        </div>))}</div>
    </section>}
    </div>
  );
}
