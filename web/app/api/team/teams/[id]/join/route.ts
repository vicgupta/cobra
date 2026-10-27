import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { joinTeam } from "@/lib/admin-teams";
import { regError } from "@/lib/registration-route";
import { getDb } from "@/lib/workflows/server";

/** The system admin moves into this team (audited). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const id = Number((await params).id);
  try { return NextResponse.json({ team: joinTeam(getDb(), g.user, id) }); } catch (e) { return regError(e); }
}
