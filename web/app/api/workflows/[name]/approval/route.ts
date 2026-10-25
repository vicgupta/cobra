import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { decide } from "@/lib/workflows/service";

/** Approve or reject the current content hash. 403 unless the user is an allowed approver. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = decide(getDb(), actor(g.user), (await ctx.params).name, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
