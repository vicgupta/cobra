import { Suspense } from "react";
import Link from "next/link";
import { Card } from "@/components/ui";
import { CollabPage, WithRepo } from "@/components/collab-page";
import { AuditTable, Body, Comments, DetailHeader, ListSkeleton, ghDate } from "@/components/collab-view";
import { CommentForm, CreatePrForm } from "@/components/collab";
import { listAgents } from "@/lib/agents";
import { listAudit } from "@/lib/collab";

export const metadata = { title: "Issue · Cobra" };

async function IssuePageBody({ params }: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  const p = await params, full = `${p.owner}/${p.repo}`, n = Number(p.number);
  return (
    <CollabPage title={`Issue #${p.number}`} crumbs={<Link href={`/repos/issues/${full}`} className="underline">← {full} issues</Link>}>
      {(u) => <WithRepo u={u} repo={full} render={async ({ db, gh, repo }) => {
        const [issue, comments] = await Promise.all([gh.getIssue(repo, n), gh.issueComments(repo, n)]);
        const audit = listAudit(db, u.tenantId, repo, n);
        const prs = audit.filter((a) => a.action === "pr_create" && a.detail.startsWith("PR #")).map((a) => a.detail.slice(4));
        return (
          <div className="space-y-6">
            <DetailHeader title={issue.title} number={n} state={issue.state} href={issue.html_url} meta={<><span className="font-medium text-fg-soft">{issue.user?.login ?? "?"}</span> opened {ghDate(issue.created_at)}</>} />
            {issue.labels && issue.labels.length > 0 && <div className="-mt-3 flex flex-wrap gap-1.5">{issue.labels.map((l) => <span key={l.name} className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-info ring-1 ring-inset ring-sky-500/30">{l.name}</span>)}</div>}
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-6">
                <Card title="Description">
                  <Body text={issue.body} />
                  {prs.length > 0 && <p className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm"><span className="text-subtle">Pull requests:</span>{prs.map((x) => <Link key={x} className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet underline ring-1 ring-inset ring-violet-500/30" href={`/repos/pull-requests/${repo}/${x}`}>#{x}</Link>)}</p>}
                </Card>
                <Comments title={`Comments (${comments.length})`} items={comments} />
                <Card title="Add a comment"><CommentForm repo={repo} number={n} /></Card>
              </div>
              {!issue.pull_request && issue.state === "open" && <Card className="lg:sticky lg:top-4" title="Create PR" subtitle="An agent works on this issue and opens a PR that references it."><CreatePrForm repo={repo} number={n} agents={listAgents(db, u.tenantId).map((a) => ({ name: a.name, engine: a.engine }))} /></Card>}
            </div>
            <AuditTable rows={audit} />
          </div>
        );
      }} />}
    </CollabPage>
  );
}

export default function IssuePage(props: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  return <Suspense fallback={<ListSkeleton />}><IssuePageBody {...props} /></Suspense>;
}
