import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { createTeam, listTeams } from "@/lib/admin-teams";
import { regError } from "@/lib/registration-route";
import { getDb } from "@/lib/workflows/server";

/** All teams (system admins only). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try { return NextResponse.json({ teams: listTeams(getDb(), g.user) }); } catch (e) { return regError(e); }
}

/** { name: string, join?: boolean (default true) } — system admins only (audited). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { name?: unknown; join?: unknown } | null;
  try { return NextResponse.json({ team: createTeam(getDb(), g.user, b?.name, b?.join ?? true) }, { status: 201 }); } catch (e) { return regError(e); }
}
