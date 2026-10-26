import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { sendEmail } from "@/lib/mail";
import { createInvite, listInvites } from "@/lib/registration";
import { regError } from "@/lib/registration-route";
import { getDb } from "@/lib/workflows/server";

const canAct = (role: string) => role === "admin" || role === "team_lead";

export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  if (!canAct(g.user.role)) return NextResponse.json({ error: "only team leads and system admins can see invites" }, { status: 403 });
  return NextResponse.json({ invites: listInvites(getDb(), g.user.tenantId) });
}

/** { email, role?: "member" | "team_lead" (admins only) } */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    return NextResponse.json(await createInvite(getDb(), g.user, b ?? {}, sendEmail), { status: 201 });
  } catch (e) { return regError(e); }
}
