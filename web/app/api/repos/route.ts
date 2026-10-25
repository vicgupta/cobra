import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { addTeamRepo, canManageRepos, cleanPat, globalCeiling, listTeamRepos, removeTeamRepo, RepoError, setRepoPat, verifyPat } from "@/lib/repos";
import { parseKey, SecretKeyError } from "@/lib/secret-box";
import { actor, getDb, githubTokenSet, secretKey } from "@/lib/workflows/server";

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
  const b = (await req.json().catch(() => null)) as { repo?: unknown; defaultBranch?: unknown; pat?: unknown } | null;
  if (!b || typeof b.repo !== "string") return NextResponse.json({ error: "repo is required" }, { status: 400 });
  if (b.pat !== undefined && b.pat !== null && typeof b.pat !== "string") return NextResponse.json({ error: "pat must be a string" }, { status: 400 });
  const pat = typeof b.pat === "string" && b.pat.trim() ? b.pat : null;
  const db = getDb(), u = actor(g.user);
  try {
    if (!canManageRepos(u)) throw new RepoError(403, "only admins and team leads can manage repos");
    // Check the token (key present, well-formed, accepted by GitHub) before registering anything.
    let check: { push: boolean | null } | undefined;
    if (pat) { keyOrFail(); check = await verifyPat(b.repo.trim(), cleanPat(pat)); }
    let r = addTeamRepo(db, u, b.repo, typeof b.defaultBranch === "string" ? b.defaultBranch : undefined);
    if (pat) r = setRepoPat(db, u, r.repo, pat, secretKey());
    return NextResponse.json({ ...r, ...(check ? { pushAccess: check.push } : {}) }, { status: 201 });
  } catch (e) { return fail(e); }
}

function keyOrFail() {
  try { parseKey(secretKey()); } catch (e) { throw new RepoError(503, e instanceof SecretKeyError ? e.message : "COBRA_SECRET_KEY is invalid"); }
}

/** Replace ({repo, pat: "..."}) or clear ({repo, pat: null}) a repo's token. Returns only patSet/patLast4. */
export async function PATCH(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { repo?: unknown; pat?: unknown } | null;
  if (!b || typeof b.repo !== "string") return NextResponse.json({ error: "repo is required" }, { status: 400 });
  if (b.pat !== null && typeof b.pat !== "string") return NextResponse.json({ error: "pat must be a string, or null to clear" }, { status: 400 });
  const db = getDb(), u = actor(g.user);
  try {
    if (!canManageRepos(u)) throw new RepoError(403, "only admins and team leads can manage repo tokens");
    if (b.pat === null || !b.pat.trim()) return NextResponse.json(setRepoPat(db, u, b.repo, null, secretKey()));
    keyOrFail();
    const check = await verifyPat(b.repo.trim(), cleanPat(b.pat));
    return NextResponse.json({ ...setRepoPat(db, u, b.repo, b.pat, secretKey()), pushAccess: check.push });
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
