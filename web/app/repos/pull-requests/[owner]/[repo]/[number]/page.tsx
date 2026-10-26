import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage, WithRepo } from "@/components/collab-page";
import { AuditTable, Comments, ghDate } from "@/components/collab-view";
import { CommentForm, MergeButton } from "@/components/collab";
import { canMerge, designatedLead, listAudit } from "@/lib/collab";

export const metadata = { title: "Pull request · Cobra" };

async function PullPageBody({ params }: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  const p = await params, full = `${p.owner}/${p.repo}`, n = Number(p.number);
  return (
    <CollabPage title={`Pull request #${p.number}`} crumbs={<Link href={`/repos/pull-requests/${full}`} className="underline">{full} pull requests</Link>}>
      {(u) => <WithRepo u={u} repo={full} render={async ({ db, gh, repo }) => {
        const [pr, reviews, reviewComments, comments] = await Promise.all([gh.getPull(repo, n), gh.pullReviews(repo, n), gh.reviewComments(repo, n), gh.issueComments(repo, n)]);
        const merged = !!pr.merged || !!pr.merged_at;
        const lead = designatedLead(db, u.tenantId);
        return (
          <div className="space-y-6">
            <Card title={pr.title} subtitle={`${pr.head.ref} → ${pr.base.ref} · ${pr.user?.login ?? "?"} · ${ghDate(pr.created_at)}`} action={<div className="flex items-center gap-2"><Badge tone={merged ? "violet" : pr.state === "open" ? "green" : "gray"}>{merged ? "merged" : pr.state}</Badge><a className="text-xs underline" href={pr.html_url} target="_blank" rel="noreferrer">GitHub</a></div>}>
              <pre className="whitespace-pre-wrap font-sans text-sm text-zinc-200">{pr.body || "(no description)"}</pre>
            </Card>
            <Card title="Merge" subtitle={`Only the team's designated lead${lead ? ` (${lead.email})` : " (none set)"} or a system admin can merge.`}>
              {merged ? <p className="text-sm text-zinc-400">Merged {ghDate(pr.merged_at)}.</p>
                : pr.state !== "open" ? <p className="text-sm text-zinc-400">Closed without merging.</p>
                : canMerge(db, u) ? <MergeButton repo={repo} number={n} base={pr.base.ref} />
                : <p className="text-sm text-zinc-500">You can review and comment, but you can&apos;t merge.</p>}
            </Card>
            <Card title={`Reviews (${reviews.length})`}>
              {reviews.length === 0 ? <p className="text-sm text-zinc-500">No reviews yet.</p> : <ul className="space-y-2">{reviews.map((r) => (
                <li key={r.id} className="text-sm"><Badge tone={r.state === "APPROVED" ? "green" : r.state === "CHANGES_REQUESTED" ? "red" : "gray"}>{r.state.toLowerCase().replace("_", " ")}</Badge> <span className="text-zinc-400">{r.user?.login} · {ghDate(r.submitted_at)}</span>{r.body && <pre className="mt-1 whitespace-pre-wrap font-sans text-zinc-200">{r.body}</pre>}</li>
              ))}</ul>}
            </Card>
            <Comments title={`Review comments (${reviewComments.length})`} items={reviewComments} />
            <Comments title={`Comments (${comments.length})`} items={comments} />
            <Card title="Add a comment"><CommentForm repo={repo} number={n} /></Card>
            <AuditTable rows={listAudit(db, u.tenantId, repo, n)} />
          </div>
        );
      }} />}
    </CollabPage>
  );
}

export default function PullPage(props: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  return <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><PullPageBody {...props} /></Suspense>;
}
