import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage, WithRepo } from "@/components/collab-page";
import { AuditTable, Comments, ghDate } from "@/components/collab-view";
import { CommentForm, CreatePrForm } from "@/components/collab";
import { listAgents } from "@/lib/agents";
import { listAudit } from "@/lib/collab";

export const metadata = { title: "Issue · Cobra" };

async function IssuePageBody({ params }: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  const p = await params, full = `${p.owner}/${p.repo}`, n = Number(p.number);
  return (
    <CollabPage title={`Issue #${p.number}`} crumbs={<Link href={`/repos/issues/${full}`} className="underline">{full} issues</Link>}>
      {(u) => <WithRepo u={u} repo={full} render={async ({ db, gh, repo }) => {
        const [issue, comments] = await Promise.all([gh.getIssue(repo, n), gh.issueComments(repo, n)]);
        const audit = listAudit(db, u.tenantId, repo, n);
        const prs = audit.filter((a) => a.action === "pr_create" && a.detail.startsWith("PR #")).map((a) => a.detail.slice(4));
        return (
          <div className="space-y-6">
            <Card title={issue.title} subtitle={`${issue.user?.login ?? "?"} · ${ghDate(issue.created_at)}`} action={<div className="flex items-center gap-2"><Badge tone={issue.state === "open" ? "green" : "gray"}>{issue.state}</Badge><a className="text-xs underline" href={issue.html_url} target="_blank" rel="noreferrer">GitHub</a></div>}>
              <pre className="whitespace-pre-wrap font-sans text-sm text-zinc-200">{issue.body || "(no description)"}</pre>
              {prs.length > 0 && <p className="mt-3 text-sm">Pull requests: {prs.map((x) => <Link key={x} className="mr-2 underline" href={`/repos/pull-requests/${repo}/${x}`}>#{x}</Link>)}</p>}
            </Card>
            {!issue.pull_request && issue.state === "open" && <Card title="Create PR" subtitle="An agent works on this issue and opens a PR that references it."><CreatePrForm repo={repo} number={n} agents={listAgents(db, u.tenantId).map((a) => ({ name: a.name, engine: a.engine }))} /></Card>}
            <Comments title={`Comments (${comments.length})`} items={comments} />
            <Card title="Add a comment"><CommentForm repo={repo} number={n} /></Card>
            <AuditTable rows={audit} />
          </div>
        );
      }} />}
    </CollabPage>
  );
}

export default function IssuePage(props: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  return <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><IssuePageBody {...props} /></Suspense>;
}
