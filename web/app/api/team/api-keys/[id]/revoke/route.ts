import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { KeyError, revokeKey } from "@/lib/team-api/keys";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try {
    return NextResponse.json({ key: revokeKey(getDb(), actor(g.user), Number((await ctx.params).id)) });
  } catch (e) {
    if (e instanceof KeyError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
