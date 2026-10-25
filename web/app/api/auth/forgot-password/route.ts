import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { sameOrigin } from "@/lib/auth/server";
import { RESET_LIMITS, requestReset, throttleReset } from "@/lib/auth/password-reset";
import { EMAIL_RE } from "@/lib/auth/users";
import { sendEmail } from "@/lib/mail";
import { clientIp } from "@/lib/client-ip";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof b?.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email" }, { status: 400 });
  if (throttleReset(`ip:${clientIp(req)}`, RESET_LIMITS.ip))
    return NextResponse.json({ error: "Too many reset requests. Try again in 15 minutes." }, { status: 429 });
  return NextResponse.json({ ok: true, message: requestReset(getDb(), email, sendEmail) });
}
