// System admin gate. COBRA_ADMIN_EMAIL is read fresh from the server env file
// (COBRA_ENV_FILE, see lib/env-file.ts) on every call; a case-insensitive exact
// match on the signed-in email. Blank or missing means nobody is the system admin.
// Deliberately no process.env fallback: the file is the single source of truth.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Same resolution as lib/env-file.ts envFilePath (kept free of server-only so tests can import it). */
export function adminEnvFilePath(): string {
  if (process.env.COBRA_ENV_FILE) return process.env.COBRA_ENV_FILE;
  return existsSync("/etc/cobra/cobra.env") ? "/etc/cobra/cobra.env" : path.join(process.cwd(), "data", "cobra.env");
}

/** COBRA_ADMIN_EMAIL from env-file text (KEY="value", last active line wins, commented lines ignored). */
export function adminEmailFrom(text: string): string {
  let out = "";
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?COBRA_ADMIN_EMAIL=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
    else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    out = v.trim();
  }
  return out;
}

export function matchesAdmin(email: string | null | undefined, adminEmail: string): boolean {
  const a = adminEmail.trim().toLowerCase();
  return !!a && !!email && email.trim().toLowerCase() === a;
}

/** Reads the env file now. Unreadable file = nobody is admin. */
export function isSystemAdmin(email: string | null | undefined, file = adminEnvFilePath()): boolean {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return false; }
  return matchesAdmin(email, adminEmailFrom(text));
}

export type GateResult = "ok" | "not-found" | "admin-only";
/**
 * Access decision used by requireUser/requireAdmin/apiGuard.
 * area "admin": only the system admin ("ok"), everyone else "not-found".
 * area "user": the system admin gets "admin-only" (pages redirect to /admin, APIs 403), others "ok".
 */
export function gate(email: string | null | undefined, area: "admin" | "user", file = adminEnvFilePath()): GateResult {
  const admin = isSystemAdmin(email, file);
  if (area === "admin") return admin ? "ok" : "not-found";
  return admin ? "admin-only" : "ok";
}
