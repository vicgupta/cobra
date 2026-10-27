import Link from "next/link";
import { CollabPage } from "@/components/collab-page";
import { Badge } from "@/components/ui";
import { StatusBadge } from "@/components/workflows";
import { getDb } from "@/lib/workflows/server";
import { list, STATUSES } from "@/lib/skills/service";
import type { Actor } from "@/lib/skills/store";
import { loadTextSkills } from "@/lib/text-skills";
import { TextSkillRun } from "@/components/text-skills";
import { listTeamRepos } from "@/lib/repos";
import { ENGINES } from "@/lib/engines";
import { AgentsTabs } from "@/components/agents-tabs";

export const metadata = { title: "Skills library · Agents · Cobra" };

type Row = { id: number; name: string; kind: string; version: number; description: string; team: string; steps: number; status: string };

export default function SkillsPage({ searchParams }: PageProps<"/agents/skills">) {
  return <CollabPage title="Agents">{(u) => <Body u={u} searchParams={searchParams} />}</CollabPage>;
}

async function Body({ u, searchParams }: { u: Actor; searchParams: PageProps<"/agents/skills">["searchParams"] }) {
  const sp = await searchParams;
  const status = typeof sp.status === "string" ? sp.status : "all";
  const rows = ((list(getDb(), u, status).body as { skills: Row[] }).skills);
  const admin = u.role === "admin";
  const text = loadTextSkills();
  return (
    <div className="space-y-6">
    <AgentsTabs active="skills" />
    <p className="text-sm text-muted">Step-by-step instructions an agent can follow. Pick one in an agent&apos;s or task&apos;s form.</p>
    <section className="space-y-3" aria-labelledby="team-skills-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="team-skills-h" className="text-base font-semibold">{admin ? "All teams' skills" : "Team skills"}</h2>
        <div className="flex items-center gap-3"><nav aria-label="Filter by status" className="flex gap-1 text-sm" data-testid="status-filter">{STATUSES.map((s) => <Link key={s} href={s === "all" ? "/agents/skills" : `/agents/skills?status=${s}`} aria-current={s === status ? "page" : undefined} className={`rounded-md px-2 py-1 capitalize ${s === status ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>{s}</Link>)}</nav>
        <Link href="/agents/skills/new" className="rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90">New skill</Link></div>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="font-medium text-fg">{status === "all" ? "No skills yet" : `No ${status} skills`}</p>
          <p className="mt-1 text-sm text-subtle">{status === "all" ? "Write down a routine once and every agent can follow it." : "Try another filter."}</p>
          {status === "all" && <Link href="/agents/skills/new" className="mt-4 inline-block rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90">Create your first skill</Link>}
        </div>) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-subtle"><tr><th scope="col" className="px-3 py-2 font-medium">Skill</th>{admin && <th scope="col" className="px-3 py-2 font-medium">Team</th>}<th scope="col" className="px-3 py-2 font-medium">Status</th></tr></thead>
          <tbody className="divide-y divide-border">{rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2.5"><Link className="font-medium text-fg hover:underline" href={`/agents/skills/${r.id}`}>{r.name}</Link>{r.kind === "master" && <> <Badge tone="violet">master</Badge></>}{r.description && <div className="text-xs text-subtle">{r.description}</div>}</td>
              {admin && <td className="px-3 py-2.5 text-xs">{r.team}</td>}
              <td className="px-3 py-2.5"><StatusBadge status={r.status} /></td>
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
