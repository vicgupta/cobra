import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { detail, update } from "@/lib/skills/service";

type Ctx = { params: Promise<{ id: string }> };
export async function GET(req: Request, ctx: Ctx) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = detail(getDb(), actor(g.user), (await ctx.params).id);
  return NextResponse.json(r.body, { status: r.status });
}

/** Save a new version (creator, team leads, designated lead, admins). */
export async function PUT(req: Request, ctx: Ctx) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = update(getDb(), actor(g.user), (await ctx.params).id, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
