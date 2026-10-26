// Page shell for issues/PR pages: auth, team-repo gate, GitHub client.
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AuthGate } from "./auth-gate";
import { GhError } from "./collab-view";
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
      <div>{crumbs && <p className="text-xs text-zinc-500">{crumbs}</p>}<h1 className="text-2xl font-semibold tracking-tight">{title}</h1></div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><AuthGate>{(su) => children(actor(su))}</AuthGate></Suspense>
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
  if (!repos.length) return <p className="text-sm text-zinc-500">No team repos yet. Add one on <Link className="underline" href="/settings/repos">Repos</Link>.</p>;
  return <ul className="space-y-2">{repos.map((r) => <li key={r.repo}><Link className="text-emerald-300 underline" href={`/repos/${kind === "pulls" ? "pull-requests" : "issues"}/${r.repo}`}>{r.repo}</Link></li>)}</ul>;
}
