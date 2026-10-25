import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiGuard } from "@/lib/auth/server";
import { endSession } from "@/lib/auth/sessions";
import { clearSessionCookie } from "@/lib/auth/cookie";

/** Ends one of the caller's own sessions (404 for any session that isn't theirs). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const { id } = await ctx.params;
  if (!endSession(getDb(), g.user.id, id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const res = NextResponse.json({ ok: true, current: id === g.user.sessionId });
  if (id === g.user.sessionId) clearSessionCookie(res);
  return res;
}
