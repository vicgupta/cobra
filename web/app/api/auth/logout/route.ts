import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { deleteSession, SESSION_COOKIE } from "@/lib/auth/sessions";
import { sameOrigin } from "@/lib/auth/server";
import { clearSessionCookie } from "@/lib/auth/cookie";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  deleteSession(getDb(), (await cookies()).get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
