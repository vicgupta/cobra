import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiGuard, secureCookies } from "@/lib/auth/server";
import { getUserTheme, setUserTheme } from "@/lib/auth/theme-db";
import { parseTheme, THEME_COOKIE, THEME_COOKIE_MAX_AGE } from "@/lib/theme";

export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const u = g.user;
  return NextResponse.json({ id: u.id, email: u.email, name: u.name, theme: getUserTheme(getDb(), u.id) ?? "system" });
}

/** PATCH { theme: "light" | "dark" | "system" }: saves it for the user and this browser. */
export async function PATCH(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { theme?: unknown } | null;
  if (!parseTheme(b?.theme)) return NextResponse.json({ error: "theme must be light, dark or system" }, { status: 400 });
  const theme = setUserTheme(getDb(), g.user.id, b!.theme);
  const res = NextResponse.json({ ok: true, theme });
  res.cookies.set(THEME_COOKIE, theme, { httpOnly: false, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: THEME_COOKIE_MAX_AGE });
  return res;
}
