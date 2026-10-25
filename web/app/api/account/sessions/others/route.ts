import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiGuard } from "@/lib/auth/server";
import { endOtherSessions } from "@/lib/auth/sessions";

/** Signs out all the caller's other sessions, keeping the current one. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  return NextResponse.json({ ok: true, ended: endOtherSessions(getDb(), g.user.id, g.user.sessionId) });
}
