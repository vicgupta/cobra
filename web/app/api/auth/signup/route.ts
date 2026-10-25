import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { EMAIL_RE, signUp } from "@/lib/auth/users";
import { createSession } from "@/lib/auth/sessions";
import { isLimited, recordFailure } from "@/lib/auth/rate-limit";
import { sameOrigin, signupAllowed } from "@/lib/auth/server";
import { setSessionCookie } from "@/lib/auth/cookie";

export async function POST(req: Request) {
  if (!signupAllowed()) return NextResponse.json({ error: "Sign-up is turned off" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const key = `signup:${req.headers.get("x-real-ip") ?? "local"}`;
  if (isLimited(key)) return NextResponse.json({ error: "Too many sign-ups. Try again later." }, { status: 429 });
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const s = (k: string) => (typeof b?.[k] === "string" ? (b[k] as string).trim() : "");
  const name = s("name"), email = s("email"), team = s("team"), password = typeof b?.password === "string" ? b.password : "";
  if (!name || !team) return NextResponse.json({ error: "Name and team name are required" }, { status: 400 });
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email" }, { status: 400 });
  if (password.length < 10) return NextResponse.json({ error: "Password must be at least 10 characters" }, { status: 400 });
  recordFailure(key);
  const db = getDb();
  let userId: number;
  try {
    userId = signUp(db, { name, email, password, team });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Sign-up failed" }, { status: 409 });
  }
  const { token, expiresAt } = createSession(db, userId);
  const res = NextResponse.json({ ok: true }, { status: 201 });
  setSessionCookie(res, token, expiresAt);
  return res;
}
