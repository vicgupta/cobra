import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage, WithRepo } from "@/components/collab-page";
import { AuditTable, ghDate } from "@/components/collab-view";
import { NewIssueForms } from "@/components/collab";
import { listAgents } from "@/lib/agents";
import { listAudit } from "@/lib/collab";

export const metadata = { title: "Issues · Cobra" };

async function RepoIssuesBody({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const p = await params, full = `${p.owner}/${p.repo}`;
  return (
    <CollabPage title={`Issues · ${full}`} crumbs={<><Link href="/issues" className="underline">Issues</Link> · <Link href={`/pulls/${full}`} className="underline">Pull requests</Link></>}>
      {(u) => <WithRepo u={u} repo={full} render={async ({ db, gh, repo }) => {
        const issues = await gh.listIssues(repo);
        return (
          <div className="space-y-6">
            <Card title="Create" subtitle="Any team member, no approval needed."><NewIssueForms repo={repo} agents={listAgents(db, u.tenantId).map((a) => ({ name: a.name, engine: a.engine }))} /></Card>
            <Card title={`Open issues (${issues.length})`}>
              {issues.length === 0 ? <p className="text-sm text-zinc-500">No open issues.</p> : <ul className="divide-y divide-zinc-800">{issues.map((i) => (
                <li key={i.number} className="py-2"><Link className="text-zinc-100 hover:underline" href={`/issues/${repo}/${i.number}`}>#{i.number} {i.title}</Link>
                  <span className="ml-2 text-xs text-zinc-500">{i.user?.login} · {ghDate(i.created_at)} · {i.comments} comment(s)</span>{i.labels?.map((l) => <span key={l.name} className="ml-1"><Badge>{l.name}</Badge></span>)}</li>
              ))}</ul>}
            </Card>
            <AuditTable rows={listAudit(db, u.tenantId, repo).slice(0, 30)} />
          </div>
        );
      }} />}
    </CollabPage>
  );
}

export default function RepoIssues(props: { params: Promise<{ owner: string; repo: string }> }) {
  return <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><RepoIssuesBody {...props} /></Suspense>;
}
