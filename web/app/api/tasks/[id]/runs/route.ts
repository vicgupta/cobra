import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, runDeps } from "@/lib/workflows/server";
import { runTask } from "@/lib/task-run";

/** "Run now": any team member; uses the task's mode unless body { mode } overrides. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { mode?: unknown } | null;
  const u = actor(g.user);
  const r = runTask(getDb(), u, u.tenantId, Number((await ctx.params).id), runDeps(g.user.tenantId, u), { mode: b?.mode });
  return NextResponse.json(r.body, { status: r.status });
}
