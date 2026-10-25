import "server-only";
import type { NextResponse } from "next/server";
import { SESSION_COOKIE } from "./sessions";
import { secureCookies } from "./server";

export function setSessionCookie(res: NextResponse, token: string, expiresAt: number) {
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", expires: new Date(expiresAt) });
}
export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: 0 });
}
