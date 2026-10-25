import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authenticate } from "@/lib/auth/users";
import { createSession } from "@/lib/auth/sessions";
import { loginBlocked, recordLoginFailure, recordLoginSuccess } from "@/lib/auth/login-limit";
import { tooMany } from "@/lib/auth/limit-response";
import { sameOrigin } from "@/lib/auth/server";
import { setSessionCookie } from "@/lib/auth/cookie";
import { clientIp } from "@/lib/client-ip";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown; remember?: unknown } | null;
  if (!b || typeof b.email !== "string" || typeof b.password !== "string" || !b.email || !b.password)
    return NextResponse.json({ error: "Enter your email and password" }, { status: 400 });
  const db = getDb();
  const ip = clientIp(req);
  const blocked = loginBlocked(db, ip, b.email);
  if (blocked) return tooMany(blocked);
  const userId = authenticate(db, b.email, b.password);
  if (!userId) {
    recordLoginFailure(db, ip, b.email);
    return NextResponse.json({ error: "Wrong email or password" }, { status: 401 });
  }
  recordLoginSuccess(db, b.email);
  const remember = b.remember !== false;
  const { token, expiresAt } = createSession(db, userId, Date.now(), { remember, userAgent: req.headers.get("user-agent"), ip });
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, token, expiresAt, remember);
  return res;
}
