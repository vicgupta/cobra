import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { removeTeamEmail, requestTeamEmail, teamEmailStatus } from "@/lib/team-email";
import { getDb, secretValue } from "@/lib/workflows/server";

/** Settings > Email for the caller's own team. Responses carry the address and status only, never the token. */
const fail = (e: unknown) => { if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; };

export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  return NextResponse.json(teamEmailStatus(getDb(), g.user));
}

/** { name, displayName?, replace? }: request a mailbox from kantsy.com and store its token (encrypted). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  try { return NextResponse.json(await requestTeamEmail(getDb(), g.user, b ?? {}, secretValue("COBRA_SECRET_KEY")), { status: 201 }); } catch (e) { return fail(e); }
}

export async function DELETE(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try { return NextResponse.json(removeTeamEmail(getDb(), g.user)); } catch (e) { return fail(e); }
}
