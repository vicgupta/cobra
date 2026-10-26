import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { CollabPage, WithRepo } from "@/components/collab-page";
import { ghDate } from "@/components/collab-view";

export const metadata = { title: "Pull requests · Cobra" };

async function RepoPullsBody({ params, searchParams }: { params: Promise<{ owner: string; repo: string }>; searchParams: Promise<{ state?: string }> }) {
  const p = await params, full = `${p.owner}/${p.repo}`;
  const state = (await searchParams).state === "closed" ? "closed" : "open";
  return (
    <CollabPage title={`Pull requests · ${full}`} crumbs={<><Link href="/repos/pull-requests" className="underline">Pull requests</Link> · <Link href={`/repos/issues/${full}`} className="underline">Issues</Link></>}>
      {(u) => <WithRepo u={u} repo={full} render={async ({ gh, repo }) => {
        const pulls = await gh.listPulls(repo, state);
        return (
          <Card title={`${state === "open" ? "Open" : "Closed"} pull requests (${pulls.length})`} action={<Link className="text-xs underline" href={`/repos/pull-requests/${repo}${state === "open" ? "?state=closed" : ""}`}>{state === "open" ? "Show closed" : "Show open"}</Link>}>
            {pulls.length === 0 ? <p className="text-sm text-zinc-500">None.</p> : <ul className="divide-y divide-zinc-800">{pulls.map((x) => (
              <li key={x.number} className="py-2"><Link className="text-zinc-100 hover:underline" href={`/repos/pull-requests/${repo}/${x.number}`}>#{x.number} {x.title}</Link>
                <span className="ml-2 text-xs text-zinc-500">{x.head.ref} → {x.base.ref} · {x.user?.login} · {ghDate(x.created_at)}</span>{x.merged_at && <span className="ml-1"><Badge tone="violet">merged</Badge></span>}</li>
            ))}</ul>}
          </Card>
        );
      }} />}
    </CollabPage>
  );
}

export default function RepoPulls(props: { params: Promise<{ owner: string; repo: string }>; searchParams: Promise<{ state?: string }> }) {
  return <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><RepoPullsBody {...props} /></Suspense>;
}
