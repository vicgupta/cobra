// Optimistic check: no session cookie → /login (pages) or 401 (API).
// Every page and route also validates the session server-side.
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "./lib/db";
import { getSessionUser } from "./lib/auth/sessions";
import { gate } from "./lib/admin/gate";

const PUBLIC = ["/login", "/api/auth/login", "/forgot-password", "/api/auth/forgot-password", "/reset-password", "/api/auth/reset-password"];
// Public sign-up was removed; answer 404 for everyone instead of a login redirect.
const REMOVED = ["/signup", "/api/auth/signup"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (REMOVED.includes(pathname.replace(/\/$/, ""))) return new NextResponse("Not found", { status: 404 });
  if (PUBLIC.includes(pathname)) return NextResponse.next();
  const token = req.cookies.get("cobra_session")?.value;
  if (token) return adminGate(req, pathname, token);
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

const isAdminPath = (p: string) => p === "/admin" || p.startsWith("/admin/") || p.startsWith("/api/admin/");
const ADMIN_ALSO = ["/api/auth/logout"];

/**
 * System-admin split, enforced with real HTTP statuses before rendering (pages and APIs
 * check again server-side): the COBRA_ADMIN_EMAIL account only reaches /admin
 * (pages redirect there, APIs 403); everyone else gets 404 for /admin.
 */
function adminGate(req: NextRequest, pathname: string, token: string) {
  const user = getSessionUser(getDb(), token);
  if (!user) return NextResponse.next(); // stale cookie: the page/API handles the redirect/401
  if (isAdminPath(pathname)) {
    if (gate(user.email, "admin") === "ok") return NextResponse.next();
    return pathname.startsWith("/api/") ? NextResponse.json({ error: "Not found" }, { status: 404 }) : new NextResponse("Not found", { status: 404 });
  }
  if (gate(user.email, "user") === "admin-only" && !ADMIN_ALSO.includes(pathname)) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "The admin account can only use the admin dashboard" }, { status: 403 });
    return NextResponse.redirect(new URL("/admin", req.url));
  }
  return NextResponse.next();
}
