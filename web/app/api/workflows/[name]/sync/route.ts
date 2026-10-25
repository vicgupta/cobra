import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, githubStore } from "@/lib/workflows/server";
import { syncWorkflow } from "@/lib/workflows/service";

/** Pull the latest YAML for a github-stored workflow (a changed file needs re-approval). */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = await syncWorkflow(getDb(), actor(g.user), (await ctx.params).name, githubStore(g.user.tenantId));
  return NextResponse.json(r.body, { status: r.status });
}
