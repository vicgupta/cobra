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

/** Ids of users hidden from display (role admin or the COBRA_ADMIN_EMAIL user), as JSON for `NOT IN (SELECT value FROM json_each(?))`. */
export function hiddenUserIdsJson(db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } }, adminEmail = currentAdminEmail()): string {
  const rows = db.prepare("SELECT id, email, role FROM users").all() as Array<{ id: number; email: string; role: string }>;
  return JSON.stringify(rows.filter((r) => isHiddenSystemAdmin(r, adminEmail)).map((r) => Number(r.id)));
}

/** Removes system-admin addresses from a stored "a, b" recipients string; "[redacted]" when nothing is left but it was non-empty. */
export function scrubRecipients(text: string, hidden: (email: string) => boolean): string {
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return text;
  const kept = parts.filter((e) => e !== "[redacted]" ? !hidden(e) : true);
  return kept.length ? kept.join(", ") : "[redacted]";
}

/** Display-time: recipients text without system-admin addresses. */
export function visibleRecipients(db: Parameters<typeof hiddenUserIdsJson>[0], text: string, adminEmail = currentAdminEmail()): string {
  const admins = new Set((db.prepare("SELECT lower(email) e FROM users WHERE role = 'admin'").all() as Array<{ e: string }>).map((r) => r.e));
  return scrubRecipients(text, (e) => admins.has(e.toLowerCase()) || matchesAdmin(e, adminEmail));
}
