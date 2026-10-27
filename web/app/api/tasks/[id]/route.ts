import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { TaskError, canEditTask, deleteTask, getTask, updateTask } from "@/lib/tasks";
import { actor, getDb } from "@/lib/workflows/server";

type Ctx = { params: Promise<{ id: string }> };
const fail = (e: unknown) => { if (e instanceof TaskError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; };

export async function GET(req: Request, ctx: Ctx) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const u = actor(g.user), t = getTask(getDb(), u.tenantId, Number((await ctx.params).id));
  if (!t) return NextResponse.json({ error: "task not found" }, { status: 404 });
  return NextResponse.json({ ...t, canEdit: canEditTask(u, t, getDb()) });
}

/** Creator, team leads, the designated lead and admins only (403); other teams 404. */
export async function PATCH(req: Request, ctx: Ctx) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try { return NextResponse.json(updateTask(getDb(), actor(g.user), Number((await ctx.params).id), await req.json().catch(() => null))); } catch (e) { return fail(e); }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try { deleteTask(getDb(), actor(g.user), Number((await ctx.params).id)); return NextResponse.json({ ok: true }); } catch (e) { return fail(e); }
}
