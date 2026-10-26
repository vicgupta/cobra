import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, runDeps } from "@/lib/workflows/server";
import { runTextSkill } from "@/lib/text-skills";

/** Runs a plain-text skill: body { prompt, skill?, engine?, repo?, mode: simulated|real }. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = runTextSkill(getDb(), actor(g.user), await req.json().catch(() => null), runDeps(g.user.tenantId, actor(g.user)));
  return NextResponse.json(r.body, { status: r.status });
}
