import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { addRepoWithToken, canAddRepo, canEditRepo, canManageRepos, changeRepoToken, listRepoAudit, updateTeamRepo, globalCeiling, listTeamRepos, removeTeamRepo, RepoError } from "@/lib/repos";
import { actor, getDb, githubTokenSet, secretKey } from "@/lib/workflows/server";

/** The team's registered GitHub repos (everyone in the team can view). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const db = getDb(), u = actor(g.user);
  return NextResponse.json({ repos: listTeamRepos(db, u.tenantId).map((r) => ({ ...r, canEdit: canEditRepo(db, u, r) })), canAdd: canAddRepo(u), canManage: canManageRepos(u), audit: listRepoAudit(db, u.tenantId), ceiling: globalCeiling(), githubTokenSet: githubTokenSet() });
}

const fail = (e: unknown) => {
  if (e instanceof RepoError) return NextResponse.json({ error: e.message }, { status: e.status });
  throw e;
};

export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { repo?: unknown; defaultBranch?: unknown; pat?: unknown } | null;
  if (!b || typeof b.repo !== "string") return NextResponse.json({ error: "repo is required" }, { status: 400 });
  if (b.pat !== undefined && b.pat !== null && typeof b.pat !== "string") return NextResponse.json({ error: "pat must be a string" }, { status: 400 });
  try {
    const r = await addRepoWithToken(getDb(), actor(g.user), { repo: b.repo, defaultBranch: typeof b.defaultBranch === "string" ? b.defaultBranch : undefined, pat: typeof b.pat === "string" ? b.pat : null }, secretKey());
    return NextResponse.json(r, { status: 201 });
  } catch (e) { return fail(e); }
}

/** Replace ({repo, pat: "..."}) or clear ({repo, pat: null}) a repo's token. Returns only patSet/patLast4. */
export async function PATCH(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { repo?: unknown; pat?: unknown; defaultBranch?: unknown } | null;
  if (!b || typeof b.repo !== "string") return NextResponse.json({ error: "repo is required" }, { status: 400 });
  if (b.defaultBranch !== undefined && b.pat === undefined) {
    if (b.defaultBranch !== null && typeof b.defaultBranch !== "string") return NextResponse.json({ error: "defaultBranch must be a string or null" }, { status: 400 });
    try { return NextResponse.json(updateTeamRepo(getDb(), actor(g.user), b.repo, b.defaultBranch)); } catch (e) { return fail(e); }
  }
  if (b.pat !== null && typeof b.pat !== "string") return NextResponse.json({ error: "pat must be a string, or null to clear" }, { status: 400 });
  try { return NextResponse.json(await changeRepoToken(getDb(), actor(g.user), b.repo, b.pat, secretKey())); } catch (e) { return fail(e); }
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
