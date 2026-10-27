import Link from "next/link";
import { CollabPage } from "@/components/collab-page";
import { Badge } from "@/components/ui";
import { getDb } from "@/lib/workflows/server";
import { list } from "@/lib/skills/service";
import type { Actor } from "@/lib/skills/store";
import { loadTextSkills } from "@/lib/text-skills";
import { TextSkillRun } from "@/components/text-skills";
import { listTeamRepos } from "@/lib/repos";
import { ENGINES } from "@/lib/engines";
import { AgentsTabs } from "@/components/agents-tabs";

export const metadata = { title: "Skills library · Agents · Cobra" };

type Row = { id: number; name: string; kind: string; version: number; description: string; team: string; steps: number };

export default function SkillsPage() {
  return <CollabPage title="Agents">{(u) => <Body u={u} />}</CollabPage>;
}

function Body({ u }: { u: Actor }) {
  const rows = ((list(getDb(), u).body as { skills: Row[] }).skills);
  const text = loadTextSkills();
  return (
    <div className="space-y-6">
    <AgentsTabs active="skills" />
    <p className="text-sm text-muted">Step-by-step instructions an agent can follow. Everyone on your team can use and run every skill here.</p>
    <section className="space-y-3" aria-labelledby="team-skills-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="team-skills-h" className="text-base font-semibold">Team skills</h2>
        <Link href="/agents/skills/new" className="rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90">New skill</Link>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="font-medium text-fg">No skills yet</p>
          <p className="mt-1 text-sm text-subtle">Write down a routine once and every agent can follow it.</p>
          {<Link href="/agents/skills/new" className="mt-4 inline-block rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90">Create your first skill</Link>}
        </div>) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-subtle"><tr><th scope="col" className="px-3 py-2 font-medium">Skill</th></tr></thead>
          <tbody className="divide-y divide-border">{rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2.5"><Link className="font-medium text-fg hover:underline" href={`/agents/skills/${r.id}`}>{r.name}</Link>{r.kind === "master" && <> <Badge tone="violet">master</Badge></>}{r.description && <div className="text-xs text-subtle">{r.description}</div>}</td>
            </tr>))}</tbody>
        </table></div>)}
    </section>
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
