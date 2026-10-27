import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { sendEmail } from "@/lib/mail";
import { getDb } from "@/lib/db";
import { canEditTeamNotify, sendTeamTestNow, setTeamNotifyEnabled, teamDigestFor, teamNotifyStatus } from "@/lib/team-notifications";

const err = (e: unknown) => { if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; };

// The team is ALWAYS the signed-in user's own (g.user.tenantId). Any tenantId/team in the query or body is ignored.

/** Any signed-in team member: their own team's digest and settings. */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const db = getDb();
  return NextResponse.json({ team: teamNotifyStatus(db, g.user), digest: teamDigestFor(db, g.user) });
}

/** Team leads, the designated lead and system admins: { enabled } or { action: "test" }. Members get 403. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const db = getDb();
  if (!canEditTeamNotify(db, g.user)) return NextResponse.json({ error: "only team leads, the designated lead and system admins can change team notifications" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { enabled?: unknown; action?: unknown } | null;
  try {
    if (b?.action === "test") return NextResponse.json({ team: await sendTeamTestNow(db, g.user, sendEmail) });
    if (b && "enabled" in b) return NextResponse.json({ team: setTeamNotifyEnabled(db, g.user, b.enabled) });
    throw new CollabError(400, "send { enabled: boolean } or { action: \"test\" }");
  } catch (e) { return err(e); }
}
