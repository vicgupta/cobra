import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, runDeps } from "@/lib/workflows/server";
import { startRun } from "@/lib/workflows/service";

/** Starts a run (409 unless this exact version is approved); executes in the background. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = startRun(getDb(), actor(g.user), (await ctx.params).name, await req.json().catch(() => null), runDeps(g.user.tenantId));
  return NextResponse.json(r.body, { status: r.status });
}
