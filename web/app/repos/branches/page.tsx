import { Suspense } from "react";
import { Badge, Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { GhError } from "@/components/collab-view";
import { RepoSelect } from "@/components/repo-select";
import { branchRepos } from "@/lib/repo-hub";
import { repoBranches } from "@/lib/repo-hub-server";
import { getDb } from "@/lib/workflows/server";
import type { Actor } from "@/lib/workflows/store";

export const metadata = { title: "Branches · Repos · Cobra" };

async function RepoBranches({ u, repo }: { u: Actor; repo: string }) {
  let b: Awaited<ReturnType<typeof repoBranches>>;
  try {
    b = await repoBranches(u, repo);
  } catch (e) {
    return <Card title={repo}><GhError e={e} /></Card>;
  }
  return <Card title={b.repo} subtitle={`${b.branches.length} branch${b.branches.length === 1 ? "" : "es"}`}>
      {b.branches.length === 0 ? <p className="text-sm text-subtle">None.</p> : <ul className="divide-y divide-border">{b.branches.map((x) => (
        <li key={x.name} className="flex items-center gap-2 py-1.5 text-sm"><span className="font-mono">{x.name}</span>{x.name === b.defaultBranch && <Badge tone="green">default</Badge>}{x.protected && <Badge tone="gray">protected</Badge>}<span className="ml-auto font-mono text-xs text-subtle">{x.sha.slice(0, 7)}</span></li>
      ))}</ul>}
    </Card>;
}

async function Body({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  const want = (await searchParams).repo;
  return <CollabPage title="Branches">{(u) => {
    const repos = branchRepos(getDb(), u);
    const shown = want ? [want] : repos;
    return <div className="space-y-4">
      <RepoSelect base="/repos/branches" repos={repos} current={want} />
      {shown.length === 0 ? <p className="text-sm text-subtle">No team repos yet.</p> : shown.map((r) => <RepoBranches key={r} u={u} repo={r} />)}
    </div>;
  }}</CollabPage>;
}

export default function ReposBranches(props: { searchParams: Promise<{ repo?: string }> }) {
  return <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><Body {...props} /></Suspense>;
}
