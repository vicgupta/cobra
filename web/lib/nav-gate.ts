// Who gets header nav links + user menu. Pure so it is unit-testable and shared by the
// server layout (decides what is rendered at all) and the client Nav (route-level hiding).
export const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/agents", label: "Agents" },
  { href: "/tasks", label: "Tasks" },
  { href: "/repos", label: "Repos" },
  { href: "/settings", label: "Settings" },
] as const;
export const ADMIN_LINK = { href: "/admin", label: "Admin" } as const;

/** Sign-up / sign-in flow screens: never show nav links or the user menu, even with a session. */
export const AUTH_FLOW_PATHS = ["/login", "/register", "/register/confirm", "/forgot-password", "/reset-password"] as const;

export function isAuthFlowPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return AUTH_FLOW_PATHS.some((a) => p === a || p.startsWith(`${a}/`));
}

type NavUser = { tenantId?: number | null; tenantSlug?: string | null } | null | undefined;

/** A completed account: a valid session whose user belongs to a team. */
export function hasCompletedMembership(u: NavUser): boolean {
  return !!u && typeof u.tenantId === "number" && u.tenantId > 0 && !!u.tenantSlug;
}

export function navLinksFor(u: NavUser, admin: boolean, pathname?: string | null): Array<{ href: string; label: string }> {
  if (!hasCompletedMembership(u) || isAuthFlowPath(pathname)) return [];
  return admin ? [...NAV_LINKS, ADMIN_LINK] : [...NAV_LINKS];
}

export function showUserMenu(u: NavUser, pathname?: string | null): boolean {
  return hasCompletedMembership(u) && !isAuthFlowPath(pathname);
}
