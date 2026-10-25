// Shared glue for the issues/PR API routes: guard, actor, GitHub client, error mapping.
import "server-only";
import { NextResponse } from "next/server";
import { apiGuard } from "./auth/server";
import { CollabError } from "./collab";
import { GitHubApiError, type GitHub } from "./github-api";
import { actor, getDb, githubClient, runDeps } from "./workflows/server";
import type { DB } from "./db";
import type { Actor } from "./workflows/store";
import type { RunDeps } from "./workflows/service";

export type RepoParams = { params: Promise<{ owner: string; repo: string; number?: string }> };
type Ctx = { db: DB; gh: GitHub; u: Actor; repo: string; number?: string; deps: () => RunDeps; body: unknown };

export async function collabRoute(req: Request, ctx: RepoParams, fn: (c: Ctx) => Promise<unknown>, status = 200) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const p = await ctx.params;
  const body = req.method === "GET" ? null : await req.json().catch(() => null);
  try {
    const out = await fn({ db: getDb(), gh: githubClient(), u: actor(g.user), repo: `${p.owner}/${p.repo}`, number: p.number, deps: () => runDeps(g.user.tenantId), body });
    return NextResponse.json(out, { status });
  } catch (e) {
    if (e instanceof CollabError || e instanceof GitHubApiError) return NextResponse.json({ error: e.message }, { status: e instanceof GitHubApiError && e.status === 401 ? 502 : e.status });
    throw e;
  }
}
