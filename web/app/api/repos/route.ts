import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { addTeamRepo, canManageRepos, globalCeiling, listTeamRepos, removeTeamRepo, RepoError } from "@/lib/repos";
import { actor, getDb, githubTokenSet } from "@/lib/workflows/server";

/** The team's registered GitHub repos (everyone in the team can view). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  return NextResponse.json({ repos: listTeamRepos(getDb(), g.user.tenantId), canManage: canManageRepos(g.user), ceiling: globalCeiling(), githubTokenSet: githubTokenSet() });
}

const fail = (e: unknown) => {
  if (e instanceof RepoError) return NextResponse.json({ error: e.message }, { status: e.status });
  throw e;
};

export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { repo?: unknown; defaultBranch?: unknown } | null;
  if (!b || typeof b.repo !== "string") return NextResponse.json({ error: "repo is required" }, { status: 400 });
  try {
    return NextResponse.json(addTeamRepo(getDb(), actor(g.user), b.repo, typeof b.defaultBranch === "string" ? b.defaultBranch : undefined), { status: 201 });
  } catch (e) { return fail(e); }
}

export async function DELETE(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const repo = new URL(req.url).searchParams.get("repo") ?? "";
  try {
    removeTeamRepo(getDb(), actor(g.user), repo);
    return NextResponse.json({ ok: true });
  } catch (e) { return fail(e); }
}
