import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { getDb } from "@/lib/db";
import { sendEmail } from "@/lib/mail";
import { sendTeamTestNow, setMyOptOut, setTeamNotifyEnabled, setTeamNotifyMode, teamNotifyStatus } from "@/lib/team-notifications";

const err = (e: unknown) => { if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; };

/** The signed-in user's own team only (any member can read). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  return NextResponse.json({ notifications: teamNotifyStatus(getDb(), g.user) });
}

/** { enabled } and { recipients: "leads" | "all" } and { action: "test" }: team leads/admins. { optOut }: anyone, own copy. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const db = getDb();
  try {
    if (b?.action === "test") return NextResponse.json({ notifications: await sendTeamTestNow(db, g.user, sendEmail) });
    if (b && "optOut" in b) return NextResponse.json({ notifications: setMyOptOut(db, g.user, b.optOut) });
    if (b && "recipients" in b) return NextResponse.json({ notifications: setTeamNotifyMode(db, g.user, b.recipients) });
    if (b && "enabled" in b) return NextResponse.json({ notifications: setTeamNotifyEnabled(db, g.user, b.enabled) });
    throw new CollabError(400, "send { enabled }, { recipients: \"leads\" | \"all\" }, { optOut } or { action: \"test\" }");
  } catch (e) { return err(e); }
}
