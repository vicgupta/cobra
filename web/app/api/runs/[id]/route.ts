import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { runDetailFor } from "@/lib/workflows/service";

/** Run status and step log. Visible to the user who started it and admins of its tenant. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = runDetailFor(getDb(), actor(g.user), (await ctx.params).id);
  return NextResponse.json(r.body, { status: r.status });
}
