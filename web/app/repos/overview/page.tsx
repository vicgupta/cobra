import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { GhError, ghDate } from "@/components/collab-view";
import { lastRun } from "@/lib/repo-hub";
import { canManageRepos, listTeamRepos, type TeamRepo } from "@/lib/repos";
import { getDb, githubClient } from "@/lib/workflows/server";
import type { Actor } from "@/lib/workflows/store";

export const metadata = { title: "Overview · Repos · Cobra" };

async function RepoCard({ u, r }: { u: Actor; r: TeamRepo }) {
  const run = lastRun(getDb(), u.tenantId, r.repo);
  let data: { branch: string; issues: number | null; prs: number; capped: boolean } | null = null, err: unknown = null;
  try {
    const c = githubClient(u.tenantId);
    const [info, pulls] = await Promise.all([c.repoInfo(r.repo), c.listPulls(r.repo)]);
    const prs = pulls.length, capped = prs >= 50;
    data = { branch: info.default_branch, prs, capped, issues: typeof info.open_issues_count === "number" && !capped ? Math.max(0, info.open_issues_count - prs) : null };
  } catch (e) {
    err = e;
  }
  const gh = data ? <dl className="grid grid-cols-3 gap-2 text-sm">
      <div><dt className="text-xs text-zinc-500">Default branch</dt><dd className="font-mono">{data.branch}</dd></div>
      <div><dt className="text-xs text-zinc-500">Open issues</dt><dd><Link className="underline" href={`/repos/issues/${r.repo}`}>{data.issues ?? "—"}</Link></dd></div>
      <div><dt className="text-xs text-zinc-500">Open PRs</dt><dd><Link className="underline" href={`/repos/pull-requests/${r.repo}`}>{data.capped ? "50+" : data.prs}</Link></dd></div>
    </dl> : <GhError e={err} />;
  return (
    <Card title={r.repo} action={<Badge tone={r.patSet ? "green" : "gray"}>{r.patSet ? "Repo PAT set" : "Uses GITHUB_TOKEN"}</Badge>}>
      <div className="space-y-3">
        {gh}
        <p className="text-sm text-zinc-400">Last Cobra run: {run ? <><Link className="font-mono text-xs underline" href={`/runs/${run.id}`}>{run.id}</Link> · {run.title} · {run.status ?? "—"} · {ghDate(new Date(run.startedAt).toISOString())}</> : "none yet"}</p>
      </div>
    </Card>
  );
}

export default function ReposOverview() {
  return <CollabPage title="Overview">{(u) => {
    const repos = listTeamRepos(getDb(), u.tenantId);
    return <div className="space-y-4">
      {canManageRepos(u) && <p className="text-sm text-zinc-400">Add repos and tokens on <Link className="underline" href="/settings/repos">Settings &gt; Repos</Link>.</p>}
      {repos.length === 0 ? <p className="text-sm text-zinc-500">No team repos yet.</p> : <div className="grid gap-4 md:grid-cols-2">{repos.map((r) => <RepoCard key={r.repo} u={u} r={r} />)}</div>}
    </div>;
  }}</CollabPage>;
}
