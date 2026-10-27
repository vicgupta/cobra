// Page shell for issues/PR pages: auth, team-repo gate, GitHub client.
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AuthGate } from "./auth-gate";
import { focusRing, GhError, ListSkeleton } from "./collab-view";
import { repoGate } from "@/lib/collab";
import { listTeamRepos } from "@/lib/repos";
import { actor, getDb, githubClient } from "@/lib/workflows/server";
import type { GitHub } from "@/lib/github-api";
import type { DB } from "@/lib/db";
import type { Actor } from "@/lib/workflows/store";

type Ctx = { db: DB; gh: GitHub; u: Actor; repo: string };

export function CollabPage({ title, crumbs, children }: { title: string; crumbs?: ReactNode; children: (u: Actor) => ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">{crumbs && <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-1.5 text-xs text-subtle [&_a]:rounded [&_a]:no-underline [&_a:hover]:text-fg [&_a:hover]:underline">{crumbs}</nav>}<h1 className="break-words text-2xl font-semibold tracking-tight">{title}</h1></div>
      <Suspense fallback={<ListSkeleton />}><AuthGate>{(su) => children(actor(su))}</AuthGate></Suspense>
    </div>
  );
}

/** Resolves the repo against the team's list, then renders; errors (unknown repo, GitHub) render inline. */
export async function WithRepo({ u, repo, render }: { u: Actor; repo: string; render: (c: Ctx) => Promise<ReactNode> }) {
  const db = getDb();
  try {
    return await render({ db, gh: githubClient(u.tenantId), u, repo: repoGate(db, u, repo) });
  } catch (e) {
    return <GhError e={e} />;
  }
}

export function RepoPicker({ u, kind }: { u: Actor; kind: "issues" | "pulls" }) {
  const repos = listTeamRepos(getDb(), u.tenantId);
  if (!repos.length) return <div className="rounded-lg border border-dashed border-border-strong px-6 py-10 text-center"><p className="text-sm font-medium text-fg-soft">No team repos yet</p><p className="mt-1 text-xs text-subtle">Add one on <Link className="underline" href="/settings/repos">Repos</Link>.</p></div>;
  return <ul className="grid gap-3 sm:grid-cols-2">{repos.map((r) => {
    const primary = `/repos/${kind === "pulls" ? "pull-requests" : "issues"}/${r.repo}`;
    return (
      <li key={r.repo} className="rounded-lg border border-border bg-bg/40 transition-colors hover:border-emerald-500/50 hover:bg-surface-2/60">
        <Link className={`flex min-h-14 items-center justify-between gap-3 rounded-lg px-4 py-3 ${focusRing}`} href={primary}>
          <span className="min-w-0"><span className="block truncate font-mono text-sm font-medium text-fg">{r.repo}</span><span className="text-xs text-subtle">{kind === "pulls" ? "View pull requests" : "View and create issues"}</span></span>
          <span aria-hidden className="text-faint">›</span>
        </Link>
      </li>
    );
  })}</ul>;
}
