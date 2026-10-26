import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { revokeInvite } from "@/lib/registration";
import { regError } from "@/lib/registration-route";
import { getDb } from "@/lib/workflows/server";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try {
    revokeInvite(getDb(), g.user, Number((await ctx.params).id));
    return NextResponse.json({ ok: true });
  } catch (e) { return regError(e); }
}
