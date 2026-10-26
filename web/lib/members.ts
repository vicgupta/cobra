// Display rule (global): system admins are never shown in team member lists, pickers or member counts, for any
// team or viewer. A system admin is role 'admin' or the COBRA_ADMIN_EMAIL user (read fresh from the env file).
// Display only: memberships, roles, permissions and email delivery are unchanged. Admin-only user management
// (/admin) deliberately still lists them.
import { readFileSync } from "node:fs";
import { adminEmailFrom, adminEnvFilePath, matchesAdmin } from "./admin/gate";

/** COBRA_ADMIN_EMAIL from the env file now ("" when unreadable). Never logged. */
export function currentAdminEmail(file = adminEnvFilePath()): string {
  try { return adminEmailFrom(readFileSync(file, "utf8")); } catch { return ""; }
}

export const isHiddenSystemAdmin = (m: { role?: string; email: string }, adminEmail: string) => m.role === "admin" || matchesAdmin(m.email, adminEmail);

/** The one filter every displayed member list goes through. */
export function visibleMembers<T extends { role?: string; email: string }>(rows: T[], adminEmail = currentAdminEmail()): T[] {
  return rows.filter((m) => !isHiddenSystemAdmin(m, adminEmail));
}
