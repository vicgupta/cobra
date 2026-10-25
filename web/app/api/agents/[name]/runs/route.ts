import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, runDeps } from "@/lib/workflows/server";
import { runAgent } from "@/lib/workflows/service";

/** Direct run of a team agent (no workflow approval); body { repo?, mode: simulated|real, instructions? }. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = runAgent(getDb(), actor(g.user), (await ctx.params).name, await req.json().catch(() => null), runDeps(g.user.tenantId, actor(g.user)));
  return NextResponse.json(r.body, { status: r.status });
}
