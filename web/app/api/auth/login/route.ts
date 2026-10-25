import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authenticate } from "@/lib/auth/users";
import { createSession } from "@/lib/auth/sessions";
import { clearFailures, isLimited, recordFailure } from "@/lib/auth/rate-limit";
import { sameOrigin } from "@/lib/auth/server";
import { setSessionCookie } from "@/lib/auth/cookie";
import { clientIp as ip } from "@/lib/client-ip";


export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown; remember?: unknown } | null;
  if (!b || typeof b.email !== "string" || typeof b.password !== "string" || !b.email || !b.password)
    return NextResponse.json({ error: "Enter your email and password" }, { status: 400 });
  const keys = [`ip:${ip(req)}`, `acct:${b.email.trim().toLowerCase()}`];
  if (keys.some((k) => isLimited(k))) return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  const db = getDb();
  const userId = authenticate(db, b.email, b.password);
  if (!userId) {
    keys.forEach((k) => recordFailure(k));
    return NextResponse.json({ error: "Wrong email or password" }, { status: 401 });
  }
  keys.forEach(clearFailures);
  const remember = b.remember !== false;
  const { token, expiresAt } = createSession(db, userId, Date.now(), { remember, userAgent: req.headers.get("user-agent"), ip: ip(req) });
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, token, expiresAt, remember);
  return res;
}
