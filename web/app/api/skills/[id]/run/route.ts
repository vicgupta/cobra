import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, runDeps } from "@/lib/workflows/server";
import { getSkill } from "@/lib/skills/store";
import { run } from "@/lib/skills/service";

/** Start a run: simulated by default (dry run, no approval needed); mode "real" needs the current hash approved. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const db = getDb(), u = actor(g.user), id = (await ctx.params).id;
  const s = getSkill(db, u, Number(id));
  const r = run(db, u, id, await req.json().catch(() => null), runDeps(s?.tenantId ?? u.tenantId, u));
  return NextResponse.json(r.body, { status: r.status });
}
