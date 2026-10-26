import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError, designatedLead, teamLeads } from "@/lib/collab";
import { displayTeamMembers, pickDesignatedLead } from "@/lib/team";
import { visibleMembers } from "@/lib/members";
import { actor, getDb } from "@/lib/workflows/server";

/** Team settings: team leads and the designated lead. */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const db = getDb();
  return NextResponse.json({ teamLeads: visibleMembers(teamLeads(db, g.user.tenantId)), designatedLead: designatedLead(db, g.user.tenantId), members: displayTeamMembers(db, g.user.tenantId).map(({ email, name, role, id }) => ({ id, email, name, role })) });
}

/** { designatedLeadUserId: number | null } (system admins only). */
export async function PUT(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { designatedLeadUserId?: unknown } | null;
  const id = b?.designatedLeadUserId;
  if (id !== null && !Number.isInteger(id)) return NextResponse.json({ error: "designatedLeadUserId must be a user id or null" }, { status: 400 });
  try {
    return NextResponse.json({ designatedLead: pickDesignatedLead(getDb(), actor(g.user), id as number | null) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
