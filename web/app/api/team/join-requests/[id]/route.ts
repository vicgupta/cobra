import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { sendEmail } from "@/lib/mail";
import { dismissJoinRequest, sendJoinLink } from "@/lib/registration";
import { regError } from "@/lib/registration-route";
import { getDb } from "@/lib/workflows/server";

/** { action: "send_link" | "dismiss" } (team leads and system admins). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const id = Number((await ctx.params).id);
  const b = (await req.json().catch(() => null)) as { action?: unknown } | null;
  try {
    if (b?.action === "send_link") return NextResponse.json({ ok: true, ...(await sendJoinLink(getDb(), g.user, id, sendEmail)) });
    if (b?.action === "dismiss") { dismissJoinRequest(getDb(), g.user, id); return NextResponse.json({ ok: true }); }
    return NextResponse.json({ error: "action must be send_link or dismiss" }, { status: 400 });
  } catch (e) { return regError(e); }
}
