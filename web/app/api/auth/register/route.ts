// Public: create-a-team / join-a-team requests (email-verified, generic responses) and invite acceptance.
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { sameOrigin } from "@/lib/auth/server";
import { consume, LIMITS } from "@/lib/auth/rate-limit";
import { tooMany } from "@/lib/auth/limit-response";
import { createSession } from "@/lib/auth/sessions";
import { setSessionCookie } from "@/lib/auth/cookie";
import { clientIp } from "@/lib/client-ip";
import { sendEmail } from "@/lib/mail";
import { acceptInvite, requestSignup } from "@/lib/registration";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const db = getDb(), ip = clientIp(req);
  const lim = consume(db, LIMITS.registerIp, ip);
  if (lim.limited) return tooMany(lim, "Too many sign-up attempts. Try again in 15 minutes.");
  if (b.mode === "invite") {
    const r = acceptInvite(db, b.invite, b);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    const s = createSession(db, r.userId, Date.now(), { remember: true, userAgent: req.headers.get("user-agent"), ip });
    const res = NextResponse.json({ ok: true });
    setSessionCookie(res, s.token, s.expiresAt, true);
    return res;
  }
  const r = await requestSignup(db, b, sendEmail);
  return NextResponse.json(r.body, { status: r.status });
}
