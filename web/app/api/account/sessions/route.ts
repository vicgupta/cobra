import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiGuard } from "@/lib/auth/server";
import { listSessions } from "@/lib/auth/sessions";

export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  return NextResponse.json({ sessions: listSessions(getDb(), g.user.id, g.user.sessionId) });
}
