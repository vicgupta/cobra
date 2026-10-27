import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage, WithRepo } from "@/components/collab-page";
import { EmptyState, ItemRow, ListSkeleton, focusRing, ghDate } from "@/components/collab-view";
import { FilterList, Segmented } from "@/components/collab";

export const metadata = { title: "Pull requests · Cobra" };

const segLink = (on: boolean) => `inline-flex min-h-9 flex-1 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors sm:flex-none ${focusRing} ${on ? "bg-bg text-fg shadow-sm ring-1 ring-border-strong" : "text-muted hover:text-fg"}`;

async function RepoPullsBody({ params, searchParams }: { params: Promise<{ owner: string; repo: string }>; searchParams: Promise<{ state?: string }> }) {
  const p = await params, full = `${p.owner}/${p.repo}`;
  const state = (await searchParams).state === "closed" ? "closed" : "open";
  return (
    <CollabPage title={`Pull requests · ${full}`} crumbs={<><Link href="/repos/pull-requests" className="underline">Pull requests</Link><span aria-hidden>·</span><Link href={`/repos/issues/${full}`} className="underline">Issues</Link></>}>
      {(u) => <WithRepo u={u} repo={full} render={async ({ gh, repo }) => {
        const pulls = await gh.listPulls(repo, state);
        return (
          <Card title={<span className="flex items-center gap-2">{state === "open" ? "Open" : "Closed"} pull requests <Badge>{pulls.length}</Badge></span>} subtitle="Newest first, from GitHub.">
            <FilterList noun="pull requests" placeholder="Filter by title, branch, author or #"
              toolbar={<Segmented label="Pull request state">
                <Link role="tab" aria-selected={state === "open"} className={segLink(state === "open")} href={`/repos/pull-requests/${repo}`}>Open</Link>
                <Link role="tab" aria-selected={state === "closed"} className={segLink(state === "closed")} href={`/repos/pull-requests/${repo}?state=closed`}>Closed</Link>
              </Segmented>}
              texts={pulls.map((x) => `#${x.number} ${x.title} ${x.head.ref} ${x.base.ref} ${x.user?.login ?? ""}`)}
              empty={<EmptyState title={state === "open" ? "No open pull requests" : "No closed pull requests"} hint={state === "open" ? <>Start one from an issue with <span className="font-medium">Create PR</span>.</> : undefined} />}>
              {pulls.map((x) => <ItemRow key={x.number} href={`/repos/pull-requests/${repo}/${x.number}`} number={x.number} title={x.title} state={x.merged_at ? "merged" : x.draft ? "draft" : x.state}
                meta={<><code className="max-w-full truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-soft">{x.head.ref} → {x.base.ref}</code><span className="font-medium text-fg-soft">{x.user?.login}</span><span aria-hidden>·</span><span>{ghDate(x.created_at)}</span></>} />)}
            </FilterList>
          </Card>
        );
      }} />}
    </CollabPage>
  );
}

export default function RepoPulls(props: { params: Promise<{ owner: string; repo: string }>; searchParams: Promise<{ state?: string }> }) {
  return <Suspense fallback={<ListSkeleton />}><RepoPullsBody {...props} /></Suspense>;
}
