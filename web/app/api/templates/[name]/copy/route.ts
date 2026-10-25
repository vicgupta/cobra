import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { templateCopy } from "@/lib/workflows/service";

/** YAML to prefill "new workflow from template" (flags dropped, you as owner). */
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = templateCopy(getDb(), actor(g.user), (await ctx.params).name);
  return NextResponse.json(r.body, { status: r.status });
}
