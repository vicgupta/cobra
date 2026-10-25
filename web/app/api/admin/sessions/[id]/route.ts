import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { getDb } from "@/lib/db";
import { endAnySession } from "@/lib/admin/metrics";

/** System admin: end any user's session by its public id. */
export async function DELETE(req: Request, ctx: RouteContext<"/api/admin/sessions/[id]">) {
  const g = await apiGuard(req, { admin: true });
  if (g.error) return g.error;
  const { id } = await ctx.params;
  if (!endAnySession(getDb(), id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
