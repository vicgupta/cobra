// Optimistic check: no session cookie → /login (pages) or 401 (API).
// Every page and route also validates the session server-side.
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/api/auth/login", "/forgot-password", "/api/auth/forgot-password", "/reset-password", "/api/auth/reset-password"];
// Public sign-up was removed; answer 404 for everyone instead of a login redirect.
const REMOVED = ["/signup", "/api/auth/signup"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (REMOVED.includes(pathname.replace(/\/$/, ""))) return new NextResponse("Not found", { status: 404 });
  if (PUBLIC.includes(pathname)) return NextResponse.next();
  if (req.cookies.get("cobra_session")?.value) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
