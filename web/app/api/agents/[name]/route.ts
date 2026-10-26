import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { AgentError, canEditAgent, deleteAgent, getAgent, updateAgent } from "@/lib/agents";
import { actor, getDb } from "@/lib/workflows/server";

type Ctx = { params: Promise<{ name: string }> };
const fail = (e: unknown) => {
  if (e instanceof AgentError) return NextResponse.json({ error: e.message }, { status: e.status });
  throw e;
};

export async function GET(req: Request, ctx: Ctx) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const u = actor(g.user), a = getAgent(getDb(), u.tenantId, (await ctx.params).name);
  if (!a) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  return NextResponse.json({ ...a, canEdit: canEditAgent(u, a, getDb()) });
}

/** Creator, team leads and admins only (403 otherwise). */
export async function PATCH(req: Request, ctx: Ctx) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try { return NextResponse.json(updateAgent(getDb(), actor(g.user), (await ctx.params).name, await req.json().catch(() => null))); } catch (e) { return fail(e); }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try { deleteAgent(getDb(), actor(g.user), (await ctx.params).name); return NextResponse.json({ ok: true }); } catch (e) { return fail(e); }
}
