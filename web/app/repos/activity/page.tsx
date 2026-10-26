import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { RepoSelect } from "@/components/repo-select";
import { activityFeed } from "@/lib/repo-hub";
import { listTeamRepos } from "@/lib/repos";
import { getDb } from "@/lib/workflows/server";

export const metadata = { title: "Activity · Repos · Cobra" };

const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

async function Body({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  const want = (await searchParams).repo;
  return <CollabPage title="Activity">{(u) => {
    const repos = listTeamRepos(getDb(), u.tenantId).map((r) => r.repo);
    const repo = want && repos.find((r) => r.toLowerCase() === want.toLowerCase());
    const items = want && !repo ? [] : activityFeed(getDb(), u.tenantId, repo || undefined);
    return <div className="space-y-4">
      <RepoSelect base="/repos/activity" repos={repos} current={want} />
      <Card title="Cobra activity" subtitle="Issue, PR, comment and merge actions, runs and finished steps, newest first.">
        {want && !repo ? <p className="text-sm text-subtle">That repo is not on your team&apos;s list.</p> : items.length === 0 ? <p className="text-sm text-subtle">No activity yet.</p> : <ul className="divide-y divide-border">{items.map((x, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
            <span className="w-36 shrink-0 text-xs text-subtle">{fmt(x.at)}</span>
            <Badge tone={x.kind === "audit" ? "violet" : x.status === "failed" ? "red" : x.kind === "run" ? "green" : "gray"}>{x.kind === "audit" ? "action" : x.kind}</Badge>
            <span className="font-mono text-xs text-muted">{x.repo}</span>
            <span>{x.label}</span>
            {x.actor && <span className="text-xs text-subtle">{x.actor}</span>}
            {x.runId && <Link className="ml-auto font-mono text-xs underline" href={`/runs/${x.runId}`}>{x.runId}</Link>}
          </li>
        ))}</ul>}
      </Card>
    </div>;
  }}</CollabPage>;
}

export default function ReposActivity(props: { searchParams: Promise<{ repo?: string }> }) {
  return <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><Body {...props} /></Suspense>;
}
