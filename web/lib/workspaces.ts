// Per-team run workspaces: <COBRA_TEAMS_ROOT>/<tenantId>/workspaces/<runId> (default root /home/cobra).
// The pre-team layout (COBRA_WORKSPACES_DIR, default <root>/workspaces) is kept as a read fallback for
// old runs. Access checks resolve real paths so traversal (..) and symlinks can't escape a team's dir.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export const teamsRoot = () => path.resolve(process.env.COBRA_TEAMS_ROOT || "/home/cobra");
/** The old shared dir (before per-team workspaces). */
export const legacyWorkspacesDir = () => path.resolve(process.env.COBRA_WORKSPACES_DIR || path.join(teamsRoot(), "workspaces"));

export function teamWorkspacesDir(tenantId: number): string {
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new Error("invalid team id");
  return path.join(teamsRoot(), String(tenantId), "workspaces");
}

const RUN_ID = /^[\w-]+$/;
/** Where a run's workspace lives: the team dir, else (old runs) the legacy dir if it still has it. */
export function runWorkspacePath(tenantId: number, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error("invalid run id");
  const p = path.join(teamWorkspacesDir(tenantId), runId);
  if (existsSync(p)) return p;
  const old = path.join(legacyWorkspacesDir(), runId);
  return existsSync(old) ? old : p;
}

/** Real path of p, or of its nearest existing ancestor joined with the rest (for not-yet-created dirs). */
function real(p: string): string {
  const abs = path.resolve(p);
  let cur = abs; const rest: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(cur), ...rest.reverse()); } catch { /* missing: go up */ }
    const up = path.dirname(cur);
    if (up === cur) return abs;
    rest.push(path.basename(cur)); cur = up;
  }
}
const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

/** May this user touch path p? Members: only inside their own team's workspaces dir. System admins:
 *  anywhere under the teams root (all teams + the legacy dir). Always on real paths; ".." segments are refused. */
export function canAccessWorkspacePath(u: { role: string; tenantId: number }, p: string): boolean {
  if (typeof p !== "string" || !p || p.split(/[\\/]+/).includes("..")) return false;
  const rp = real(p);
  if (u.role === "admin") return inside(rp, real(teamsRoot()));
  return inside(rp, real(teamWorkspacesDir(u.tenantId)));
}

/** Throws unless dir (a run workspace about to be used) is inside this team's dir after resolving symlinks. */
export function assertTeamWorkspace(tenantId: number, dir: string): void {
  if (!inside(real(dir), real(teamWorkspacesDir(tenantId)))) throw new Error("workspace escapes the team directory");
}
