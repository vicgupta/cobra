// Public: confirm an emailed sign-up link (POST only, so mail scanners that GET links don't consume it).
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { sameOrigin } from "@/lib/auth/server";
import { consume, LIMITS } from "@/lib/auth/rate-limit";
import { tooMany } from "@/lib/auth/limit-response";
import { createSession } from "@/lib/auth/sessions";
import { setSessionCookie } from "@/lib/auth/cookie";
import { clientIp } from "@/lib/client-ip";
import { sendEmail } from "@/lib/mail";
import { confirmSignup } from "@/lib/registration";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const db = getDb(), ip = clientIp(req);
  const lim = consume(db, LIMITS.confirmIp, ip);
  if (lim.limited) return tooMany(lim);
  const r = await confirmSignup(db, b?.token, sendEmail);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  if (r.kind === "join") return NextResponse.json({ ok: true, kind: "join", message: r.message });
  const s = createSession(db, r.userId, Date.now(), { remember: true, userAgent: req.headers.get("user-agent"), ip });
  const res = NextResponse.json({ ok: true, kind: "create_team" });
  setSessionCookie(res, s.token, s.expiresAt, true);
  return res;
}
