// Request-time auth helpers for pages and route handlers.
import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { gate } from "../admin/gate";
import { connection, NextResponse } from "next/server";
import { getDb } from "../db";
import { canUseSharedConfig, getSessionUser, SESSION_COOKIE, type SessionUser } from "./sessions";

export async function currentUser(): Promise<SessionUser | null> {
  await connection(); // session checks use the current time: always render per request
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUser(getDb(), token);
}

/** For pages: redirect to /login when signed out. */
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

/** For /admin pages: 404 for everyone but the system admin (COBRA_ADMIN_EMAIL). */
export async function requireAdmin(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
  if (gate(u.email, "admin") !== "ok") notFound();
  return u;
}

/** Same-origin check for state-changing requests (CSRF). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type Guard = { user: SessionUser; error?: undefined } | { user?: undefined; error: NextResponse };

/** For API routes: 401 when signed out, 403 cross-origin POST or when shared config is required and not allowed. */
export async function apiGuard(req: Request, opts: { sharedConfig?: boolean; admin?: boolean } = {}): Promise<Guard> {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return { error: NextResponse.json({ error: "Bad origin" }, { status: 403 }) };
  const user = await currentUser();
  if (!user) return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  // Admin APIs are invisible to everyone but the system admin.
  if (opts.admin) return gate(user.email, "admin") === "ok" ? { user } : { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (opts.sharedConfig && !canUseSharedConfig(user)) return { error: NextResponse.json({ error: "Only admins of the default workspace can use this for now" }, { status: 403 }) };
  return { user };
}

export const secureCookies = () => process.env.NODE_ENV === "production";
