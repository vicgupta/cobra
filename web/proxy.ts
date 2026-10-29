// Optimistic check: no session cookie → /login (pages) or 401 (API).
// Every page and route also validates the session server-side.
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "./lib/db";
import { getSessionUser } from "./lib/auth/sessions";
import { gate } from "./lib/admin/gate";

const PUBLIC = ["/login", "/api/auth/login", "/forgot-password", "/api/auth/forgot-password", "/reset-password", "/api/auth/reset-password",
  "/register", "/register/confirm", "/api/auth/register", "/api/auth/register/confirm"];
// Public sign-up was removed; answer 404 for everyone instead of a login redirect.
const REMOVED = ["/signup", "/api/auth/signup"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (REMOVED.includes(pathname.replace(/\/$/, ""))) return new NextResponse("Not found", { status: 404 });
  if (PUBLIC.includes(pathname)) return withPath(req);
  // Team API: bearer keys, checked by the route itself (401 without a valid key); cookies are not used there.
  if (pathname.startsWith("/api/v1/")) return withPath(req);
  const token = req.cookies.get("cobra_session")?.value;
  if (token) return adminGate(req, pathname, token);
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

const isAdminPath = (p: string) => p === "/admin" || p.startsWith("/admin/") || p.startsWith("/api/admin/");

/**
 * /admin and /api/admin/* are 404 (real HTTP status, before rendering) for everyone but the
 * COBRA_ADMIN_EMAIL account, which also keeps the full regular app. Pages/APIs check again.
 */
function adminGate(req: NextRequest, pathname: string, token: string) {
  if (!isAdminPath(pathname)) return withPath(req);
  const user = getSessionUser(getDb(), token);
  if (!user) return withPath(req); // stale cookie: the page/API handles the redirect/401
  if (gate(user.email, "admin") === "ok") return withPath(req);
  return pathname.startsWith("/api/") ? NextResponse.json({ error: "Not found" }, { status: 404 }) : new NextResponse("Not found", { status: 404 });
}

/** Forward the pathname to server components (root layout gates header nav on it). */
function withPath(req: NextRequest) {
  const h = new Headers(req.headers);
  h.set("x-cobra-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: h } });
}
