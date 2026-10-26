import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { rereview } from "@/lib/skills/service";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = rereview(getDb(), actor(g.user), (await ctx.params).id);
  return NextResponse.json(r.body, { status: r.status });
}
