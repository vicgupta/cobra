import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { workflowDetail } from "@/lib/workflows/service";

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = workflowDetail(getDb(), actor(g.user), (await ctx.params).name);
  return NextResponse.json(r.body, { status: r.status });
}
