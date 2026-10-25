import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { sameOrigin } from "@/lib/auth/server";
import { RESET_LIMITS, resetWithToken, throttleReset } from "@/lib/auth/password-reset";
import { clearSessionCookie } from "@/lib/auth/cookie";
import { clientIp } from "@/lib/client-ip";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { token?: unknown; password?: unknown } | null;
  if (typeof b?.token !== "string" || typeof b.password !== "string" || !b.token)
    return NextResponse.json({ error: "Missing token or password" }, { status: 400 });
  if (throttleReset(`reset-ip:${clientIp(req)}`, RESET_LIMITS.ip * 2))
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  const r = resetWithToken(getDb(), b.token, b.password);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
