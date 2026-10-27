import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, runDeps } from "@/lib/workflows/server";
import { runTeamAgent } from "@/lib/agent-run";

/** Direct run of a team agent (prompt or skill); body { repo?, mode: simulated|real, instructions? }. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = runTeamAgent(getDb(), actor(g.user), (await ctx.params).name, await req.json().catch(() => null), runDeps(g.user.tenantId, actor(g.user)));
  return NextResponse.json(r.body, { status: r.status });
}
