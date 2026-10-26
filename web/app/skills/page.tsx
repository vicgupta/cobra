import Link from "next/link";
import { CollabPage } from "@/components/collab-page";
import { Badge, Card } from "@/components/ui";
import { StatusBadge } from "@/components/workflows";
import { getDb } from "@/lib/workflows/server";
import { list, STATUSES } from "@/lib/skills/service";
import type { Actor } from "@/lib/skills/store";
import { loadTextSkills } from "@/lib/text-skills";
import { TextSkillRun } from "@/components/text-skills";
import { listTeamRepos } from "@/lib/repos";
import { ENGINES } from "@/lib/engines";

export const metadata = { title: "Skills · Cobra" };

type Row = { id: number; name: string; kind: string; version: number; description: string; team: string; steps: number; status: string; score: number | null };

export default function SkillsPage({ searchParams }: PageProps<"/skills">) {
  return <CollabPage title="Skills">{(u) => <Body u={u} searchParams={searchParams} />}</CollabPage>;
}

async function Body({ u, searchParams }: { u: Actor; searchParams: PageProps<"/skills">["searchParams"] }) {
  const sp = await searchParams;
  const status = typeof sp.status === "string" ? sp.status : "all";
  const rows = ((list(getDb(), u, status).body as { skills: Row[] }).skills);
  const admin = u.role === "admin";
  const text = loadTextSkills();
  return (
    <div className="space-y-6">
    <Card title="Text skills" subtitle="Plain-text skills (no YAML): a goal, a few steps and a trigger phrase. Run one with a free-form prompt.">
      <div className="space-y-4" data-testid="text-skills">{text.map((t) => (
        <div key={t.id} className="rounded-md border border-border p-3" data-text-skill={t.id}>
          <div className="text-sm font-medium">{t.name} <span className="text-xs text-subtle">skills/{t.id}.md · trigger: “{t.trigger}”</span></div>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-fg-soft">{t.text}</pre>
          <TextSkillRun skill={t.id} repos={listTeamRepos(getDb(), u.tenantId).map((r) => r.repo)} engines={[...ENGINES]} />
        </div>))}</div>
    </Card>
    <Card title="SOP skills" subtitle={admin ? "All teams (system admin)" : "Your team's skills: an SOP plus an ordered, validated plan"}
      action={<div className="flex items-center gap-2"><nav className="flex gap-1 text-sm" data-testid="status-filter">{STATUSES.map((s) => <Link key={s} href={s === "all" ? "/skills" : `/skills?status=${s}`} className={`rounded px-2 py-1 ${s === status ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>{s[0].toUpperCase() + s.slice(1)}</Link>)}</nav>
        <Link href="/skills/new" className="rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90">New skill</Link></div>}>
      {rows.length === 0 ? <p className="text-sm text-muted">No skills match.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-subtle"><tr><th className="py-2">Name</th>{admin && <th>Team</th>}<th>Kind</th><th>Steps</th><th>Review</th><th>Status</th></tr></thead>
          <tbody className="divide-y divide-border">{rows.map((r) => (
            <tr key={r.id}>
              <td className="py-2"><Link className="text-success hover:underline" href={`/skills/${r.id}`}>{r.name}</Link> <span className="text-xs text-subtle">v{r.version}</span>{r.description && <div className="text-xs text-subtle">{r.description}</div>}</td>
              {admin && <td className="text-xs">{r.team}</td>}
              <td>{r.kind === "master" ? <Badge tone="violet">master</Badge> : <Badge>sop</Badge>}</td>
              <td className="tabular-nums">{r.steps}</td>
              <td className="tabular-nums">{r.score ?? "—"}</td>
              <td><StatusBadge status={r.status} /></td>
            </tr>))}</tbody>
        </table>)}
    </Card>
    </div>
  );
}
