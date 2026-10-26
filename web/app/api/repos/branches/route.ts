import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { GitHubApiError } from "@/lib/github-api";
import { branchRepos } from "@/lib/repo-hub";
import { repoBranches } from "@/lib/repo-hub-server";
import { RepoError } from "@/lib/repos";
import { actor, getDb } from "@/lib/workflows/server";

/** GET ?repo=owner/name: that repo's non-Cobra branches. Without ?repo: the repos you may list. */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const u = actor(g.user), repo = new URL(req.url).searchParams.get("repo");
  if (!repo) return NextResponse.json({ repos: branchRepos(getDb(), u) });
  try {
    return NextResponse.json(await repoBranches(u, repo));
  } catch (e) {
    if (e instanceof RepoError || e instanceof GitHubApiError) return NextResponse.json({ error: e.message }, { status: e instanceof GitHubApiError && e.status === 401 ? 502 : e.status });
    throw e;
  }
}
