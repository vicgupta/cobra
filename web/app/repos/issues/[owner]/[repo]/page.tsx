import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage, WithRepo } from "@/components/collab-page";
import { AuditTable, EmptyState, ItemRow, ListSkeleton, ghDate } from "@/components/collab-view";
import { FilterList, NewIssueForms } from "@/components/collab";
import { listAgents } from "@/lib/agents";
import { listAudit } from "@/lib/collab";

export const metadata = { title: "Issues · Cobra" };

async function RepoIssuesBody({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const p = await params, full = `${p.owner}/${p.repo}`;
  return (
    <CollabPage title={`Issues · ${full}`} crumbs={<><Link href="/repos/issues" className="underline">Issues</Link><span aria-hidden>·</span><Link href={`/repos/pull-requests/${full}`} className="underline">Pull requests</Link></>}>
      {(u) => <WithRepo u={u} repo={full} render={async ({ db, gh, repo }) => {
        const issues = await gh.listIssues(repo);
        return (
          <div className="space-y-6">
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
              <Card title={<span className="flex items-center gap-2">Open issues <Badge>{issues.length}</Badge></span>} subtitle="Newest first, from GitHub.">
                <FilterList noun="issues" placeholder="Filter by title, author, label or #" texts={issues.map((i) => `#${i.number} ${i.title} ${i.user?.login ?? ""} ${(i.labels ?? []).map((l) => l.name).join(" ")}`)}
                  empty={<EmptyState title="No open issues" hint="Create one with the form, or let an agent write one." />}>
                  {issues.map((i) => <ItemRow key={i.number} href={`/repos/issues/${repo}/${i.number}`} number={i.number} title={i.title} state="open"
                    meta={<><span className="font-medium text-fg-soft">{i.user?.login}</span><span aria-hidden>·</span><span>{ghDate(i.created_at)}</span><span aria-hidden>·</span><span>💬 {i.comments} comment(s)</span></>}
                    badges={i.labels?.length ? i.labels.map((l) => <Badge key={l.name} tone="blue">{l.name}</Badge>) : undefined} />)}
                </FilterList>
              </Card>
              <Card title="Create" subtitle="Any team member, no approval needed." className="lg:sticky lg:top-4"><NewIssueForms repo={repo} agents={listAgents(db, u.tenantId).map((a) => ({ name: a.name, engine: a.engine }))} /></Card>
            </div>
            <AuditTable rows={listAudit(db, u.tenantId, repo).slice(0, 30)} />
          </div>
        );
      }} />}
    </CollabPage>
  );
}

export default function RepoIssues(props: { params: Promise<{ owner: string; repo: string }> }) {
  return <Suspense fallback={<ListSkeleton />}><RepoIssuesBody {...props} /></Suspense>;
}
