import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { designate, setMemberRole } from "@/lib/team";
import { actor, getDb } from "@/lib/workflows/server";

/** { role: "member" | "team_lead" } or { makeDesignatedLead: true } (system admins). Rules in lib/team.ts. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const id = Number((await ctx.params).id);
  const b = (await req.json().catch(() => null)) as { role?: unknown; makeDesignatedLead?: unknown } | null;
  try {
    if (b?.makeDesignatedLead === true) return NextResponse.json({ designatedLead: designate(getDb(), actor(g.user), id) });
    return NextResponse.json({ member: setMemberRole(getDb(), actor(g.user), id, b?.role) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
