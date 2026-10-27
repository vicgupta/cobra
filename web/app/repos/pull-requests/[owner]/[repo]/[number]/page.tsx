import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage, WithRepo } from "@/components/collab-page";
import { Avatar, AuditTable, Body, Comments, DetailHeader, ListSkeleton, ghDate } from "@/components/collab-view";
import { CommentForm, MergeButton } from "@/components/collab";
import { canMerge, designatedLead, listAudit } from "@/lib/collab";

export const metadata = { title: "Pull request · Cobra" };

async function PullPageBody({ params }: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  const p = await params, full = `${p.owner}/${p.repo}`, n = Number(p.number);
  return (
    <CollabPage title={`Pull request #${p.number}`} crumbs={<Link href={`/repos/pull-requests/${full}`} className="underline">← {full} pull requests</Link>}>
      {(u) => <WithRepo u={u} repo={full} render={async ({ db, gh, repo }) => {
        const [pr, reviews, reviewComments, comments] = await Promise.all([gh.getPull(repo, n), gh.pullReviews(repo, n), gh.reviewComments(repo, n), gh.issueComments(repo, n)]);
        const merged = !!pr.merged || !!pr.merged_at;
        const lead = designatedLead(db, u.tenantId);
        return (
          <div className="space-y-6">
            <DetailHeader title={pr.title} number={n} state={merged ? "merged" : pr.draft ? "draft" : pr.state} href={pr.html_url}
              meta={<><span className="font-medium text-fg-soft">{pr.user?.login ?? "?"}</span> wants to merge <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg-soft">{pr.head.ref}</code> → <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg-soft">{pr.base.ref}</code> · {ghDate(pr.created_at)}</>} />
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-6">
                <Card title="Description"><Body text={pr.body} /></Card>
                <Card title={`Reviews (${reviews.length})`}>
                  {reviews.length === 0 ? <p className="text-sm text-subtle">No reviews yet.</p> : <ul className="space-y-4">{reviews.map((r) => (
                    <li key={r.id} className="flex gap-3 text-sm"><Avatar login={r.user?.login} /><div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2"><span className="font-medium text-fg-soft">{r.user?.login}</span><Badge tone={r.state === "APPROVED" ? "green" : r.state === "CHANGES_REQUESTED" ? "red" : "gray"}>{r.state.toLowerCase().replace("_", " ")}</Badge><span className="text-xs text-subtle">{ghDate(r.submitted_at)}</span></p>
                      {r.body && <pre className="mt-1.5 whitespace-pre-wrap break-words font-sans leading-relaxed text-fg-soft">{r.body}</pre>}</div></li>
                  ))}</ul>}
                </Card>
                <Comments title={`Review comments (${reviewComments.length})`} items={reviewComments} />
                <Comments title={`Comments (${comments.length})`} items={comments} />
                <Card title="Add a comment"><CommentForm repo={repo} number={n} /></Card>
              </div>
              <Card className="lg:sticky lg:top-4 lg:order-none order-first" title="Merge" subtitle={`Only the team's designated lead${lead ? ` (${lead.email})` : " (none set)"} or a system admin can merge.`}>
                {merged ? <p className="text-sm text-muted"><Badge tone="violet" dot>merged</Badge> <span className="ml-1">Merged {ghDate(pr.merged_at)}.</span></p>
                  : pr.state !== "open" ? <p className="text-sm text-muted">Closed without merging.</p>
                  : canMerge(db, u) ? <MergeButton repo={repo} number={n} base={pr.base.ref} />
                  : <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-subtle">You can review and comment, but you can&apos;t merge.</p>}
              </Card>
            </div>
            <AuditTable rows={listAudit(db, u.tenantId, repo, n)} />
          </div>
        );
      }} />}
    </CollabPage>
  );
}

export default function PullPage(props: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  return <Suspense fallback={<ListSkeleton />}><PullPageBody {...props} /></Suspense>;
}
