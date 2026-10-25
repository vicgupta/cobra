// Per-team GitHub repo registry. The single gate for every GitHub read, write and
// run: a repo must be registered to the acting team and, if COBRA_GITHUB_ALLOWED_REPOS
// is set, also be in that global ceiling.
import type { DB } from "./db";

export type TeamRepo = { repo: string; defaultBranch: string | null; createdAt: number };
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function listTeamRepos(db: DB, tenantId: number): TeamRepo[] {
  return (db.prepare("SELECT repo, default_branch AS defaultBranch, created_at AS createdAt FROM team_repos WHERE tenant_id = ? ORDER BY repo").all(tenantId) as unknown as TeamRepo[])
    // node:sqlite rows have a null prototype, which React can't pass to Client Components.
    .map((r) => ({ repo: r.repo, defaultBranch: r.defaultBranch, createdAt: r.createdAt }));
}

export function teamRepo(db: DB, tenantId: number, repo: string): TeamRepo | undefined {
  return listTeamRepos(db, tenantId).find((r) => r.repo.toLowerCase() === repo.toLowerCase());
}

export function globalCeiling(): string[] | null {
  const l = process.env.COBRA_GITHUB_ALLOWED_REPOS?.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
  return l?.length ? l : null;
}

/** Error message, or null when the team may use this repo. */
export function checkTeamRepo(db: DB, tenantId: number, repo: string): string | null {
  if (!REPO_RE.test(repo)) return "github repo must look like owner/name";
  if (!teamRepo(db, tenantId, repo)) return `repo ${repo} is not registered to this team (see Repos)`;
  const c = globalCeiling();
  if (c && !c.includes(repo.toLowerCase())) return `repo ${repo} is not in COBRA_GITHUB_ALLOWED_REPOS`;
  return null;
}

export const canManageRepos = (u: { role: string }) => u.role === "admin" || u.role === "team_lead";

export class RepoError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function addTeamRepo(db: DB, u: { id: number; role: string; tenantId: number }, repo: string, defaultBranch?: string, now = Date.now()): TeamRepo {
  if (!canManageRepos(u)) throw new RepoError(403, "only team admins and team leads can manage repos");
  repo = repo.trim();
  if (!REPO_RE.test(repo)) throw new RepoError(400, "repo must look like owner/name");
  const b = defaultBranch?.trim() || null;
  if (b && !/^[\w./-]+$/.test(b)) throw new RepoError(400, "invalid branch name");
  if (teamRepo(db, u.tenantId, repo)) throw new RepoError(409, `${repo} is already registered`);
  db.prepare("INSERT INTO team_repos (tenant_id, repo, default_branch, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(u.tenantId, repo, b, u.id, now);
  return { repo, defaultBranch: b, createdAt: now };
}

export function removeTeamRepo(db: DB, u: { role: string; tenantId: number }, repo: string): void {
  if (!canManageRepos(u)) throw new RepoError(403, "only team admins and team leads can manage repos");
  const r = db.prepare("DELETE FROM team_repos WHERE tenant_id = ? AND lower(repo) = lower(?)").run(u.tenantId, repo);
  if (!r.changes) throw new RepoError(404, `${repo} is not registered`);
}
