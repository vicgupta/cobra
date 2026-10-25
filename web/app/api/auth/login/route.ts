import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authenticate } from "@/lib/auth/users";
import { createSession } from "@/lib/auth/sessions";
import { clearFailures, isLimited, recordFailure } from "@/lib/auth/rate-limit";
import { sameOrigin } from "@/lib/auth/server";
import { setSessionCookie } from "@/lib/auth/cookie";

const ip = (req: Request) => req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { login?: unknown; password?: unknown } | null;
  if (!b || typeof b.login !== "string" || typeof b.password !== "string" || !b.login || !b.password)
    return NextResponse.json({ error: "Enter your email or username and password" }, { status: 400 });
  const keys = [`ip:${ip(req)}`, `acct:${b.login.trim().toLowerCase()}`];
  if (keys.some((k) => isLimited(k))) return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  const db = getDb();
  const userId = authenticate(db, b.login, b.password);
  if (!userId) {
    keys.forEach((k) => recordFailure(k));
    return NextResponse.json({ error: "Wrong email/username or password" }, { status: 401 });
  }
  keys.forEach(clearFailures);
  const { token, expiresAt } = createSession(db, userId);
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, token, expiresAt);
  return res;
}
