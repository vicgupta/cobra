import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { sameOrigin } from "@/lib/auth/server";
import { requestReset } from "@/lib/auth/password-reset";
import { consume, LIMITS } from "@/lib/auth/rate-limit";
import { tooMany } from "@/lib/auth/limit-response";
import { EMAIL_RE } from "@/lib/auth/users";
import { sendEmail } from "@/lib/mail";
import { clientIp } from "@/lib/client-ip";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof b?.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email" }, { status: 400 });
  const db = getDb();
  const ip = consume(db, LIMITS.forgotIp, clientIp(req));
  if (ip.limited) return tooMany(ip, "Too many reset requests. Try again in 15 minutes.");
  // The per-email limit inside requestReset is silent (same generic response).
  return NextResponse.json({ ok: true, message: requestReset(db, email, sendEmail) });
}
