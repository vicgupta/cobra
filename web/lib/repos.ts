// Per-team GitHub repo registry. The single gate for every GitHub read, write and
// run: a repo must be registered to the acting team and, if COBRA_GITHUB_ALLOWED_REPOS
// is set, also be in that global ceiling, unless the team registered it with its own PAT
// (then the team's token, never the server GITHUB_TOKEN, is what reaches GitHub for it).
import type { DB } from "./db";
import { decryptSecret, encryptSecret, parseKey, SecretKeyError } from "./secret-box";

/** patSet/patLast4 only: the token itself never leaves the server. createdBy/createdByEmail: who added it (null for seeded repos). */
export type TeamRepo = { repo: string; defaultBranch: string | null; createdAt: number; patSet: boolean; patLast4: string | null; createdBy: number | null; createdByEmail: string | null };
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function listTeamRepos(db: DB, tenantId: number): TeamRepo[] {
  type Row = { repo: string; defaultBranch: string | null; createdAt: number; patSet: number; patLast4: string | null; createdBy: number | null; createdByEmail: string | null };
  return (db.prepare("SELECT r.repo, r.default_branch AS defaultBranch, r.created_at AS createdAt, r.pat_enc IS NOT NULL AS patSet, r.pat_last4 AS patLast4, r.created_by AS createdBy, u.email AS createdByEmail FROM team_repos r LEFT JOIN users u ON u.id = r.created_by AND u.tenant_id = r.tenant_id WHERE r.tenant_id = ? ORDER BY r.repo").all(tenantId) as unknown as Row[])
    // node:sqlite rows have a null prototype, which React can't pass to Client Components.
    .map((r) => ({ repo: r.repo, defaultBranch: r.defaultBranch, createdAt: r.createdAt, patSet: !!r.patSet, patLast4: r.patSet ? r.patLast4 : null, createdBy: r.createdBy ?? null, createdByEmail: r.createdByEmail ?? null }));
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
  // Team-added repos with their own token bypass the global ceiling (team-scoped; the PAT is the access boundary).
  if (c && !c.includes(repo.toLowerCase()) && !teamRepo(db, tenantId, repo)!.patSet) return `repo ${repo} is not in COBRA_GITHUB_ALLOWED_REPOS (add a personal access token for it in Settings > Repos to use it)`;
  return null;
}

/** Admins and team leads: manage every repo of the team (tokens included). */
export const canManageRepos = (u: { role: string }) => u.role === "admin" || u.role === "team_lead";
/** Job 8: any signed-in team member can add a repo to their own team. */
export const canAddRepo = (u: { role: string }) => u.role === "admin" || u.role === "team_lead" || u.role === "member";

type RepoUser = { id: number; email?: string; role: string; tenantId: number };
const isDesignatedLead = (db: DB, u: RepoUser) =>
  (db.prepare("SELECT designated_lead_user_id AS d FROM tenants WHERE id = ?").get(u.tenantId) as { d: number | null } | undefined)?.d === u.id;
/** Edit/remove: the repo's creator, team leads, the designated lead and admins (same rule as team agents), always within the team. */
export function canEditRepo(db: DB, u: RepoUser, r: Pick<TeamRepo, "createdBy">): boolean {
  return canManageRepos(u) || (r.createdBy !== null && r.createdBy === u.id) || isDesignatedLead(db, u);
}

export class RepoError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export type RepoAuditAction = "add" | "edit" | "remove" | "token_set" | "token_clear";
function repoAudit(db: DB, u: RepoUser, action: RepoAuditAction, repo: string, detail = "", now = Date.now()) {
  const email = u.email ?? (db.prepare("SELECT email FROM users WHERE id = ?").get(u.id) as { email: string } | undefined)?.email ?? "";
  db.prepare("INSERT INTO repo_audit (tenant_id, actor_id, actor_email, action, repo, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(u.tenantId, u.id, email, action, repo, detail, now);
}
export type RepoAuditRow = { actorEmail: string; action: RepoAuditAction; repo: string; detail: string; at: number };
export function listRepoAudit(db: DB, tenantId: number, limit = 20): RepoAuditRow[] {
  return (db.prepare("SELECT actor_email AS actorEmail, action, repo, detail, at FROM repo_audit WHERE tenant_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(tenantId, limit) as unknown as RepoAuditRow[]).map((r) => ({ ...r }));
}

const cleanBranch = (defaultBranch?: string | null) => {
  const b = defaultBranch?.trim() || null;
  if (b && !/^[\w./-]+$/.test(b)) throw new RepoError(400, "invalid branch name");
  return b;
};

export function addTeamRepo(db: DB, u: RepoUser, repo: string, defaultBranch?: string, now = Date.now()): TeamRepo {
  if (!canAddRepo(u)) throw new RepoError(403, "only team members can add repos");
  repo = repo.trim();
  if (!REPO_RE.test(repo)) throw new RepoError(400, "repo must look like owner/name");
  const b = cleanBranch(defaultBranch);
  if (teamRepo(db, u.tenantId, repo)) throw new RepoError(409, `${repo} is already registered`);
  db.prepare("INSERT INTO team_repos (tenant_id, repo, default_branch, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(u.tenantId, repo, b, u.id, now);
  repoAudit(db, u, "add", repo, b ? `default branch ${b}` : "", now);
  return teamRepo(db, u.tenantId, repo)!;
}

/** Edit a repo's default branch (null/empty = the repo's own default). */
export function updateTeamRepo(db: DB, u: RepoUser, repo: string, defaultBranch: string | null, now = Date.now()): TeamRepo {
  const r = teamRepo(db, u.tenantId, repo);
  if (!r) throw new RepoError(404, `${repo} is not registered`);
  if (!canEditRepo(db, u, r)) throw new RepoError(403, "only the repo's creator, team leads and admins can edit it");
  const b = cleanBranch(defaultBranch);
  db.prepare("UPDATE team_repos SET default_branch = ? WHERE tenant_id = ? AND repo = ?").run(b, u.tenantId, r.repo);
  repoAudit(db, u, "edit", r.repo, `default branch: ${r.defaultBranch ?? "repo default"} to ${b ?? "repo default"}`, now);
  return teamRepo(db, u.tenantId, r.repo)!;
}

export function removeTeamRepo(db: DB, u: RepoUser, repo: string, now = Date.now()): void {
  const r = teamRepo(db, u.tenantId, repo);
  if (!r) throw new RepoError(404, `${repo} is not registered`);
  if (!canEditRepo(db, u, r)) throw new RepoError(403, "only the repo's creator, team leads and admins can remove it");
  db.prepare("DELETE FROM team_repos WHERE tenant_id = ? AND repo = ?").run(u.tenantId, r.repo);
  repoAudit(db, u, "remove", r.repo, "", now);
}

// ---- Per-repo GitHub PAT (Job 19). Encrypted with COBRA_SECRET_KEY; falls back to GITHUB_TOKEN when unset.

/** Trimmed token, or a RepoError for an obviously malformed one. */
export function cleanPat(token: string): string {
  const t = token.trim();
  if (t.length < 20 || t.length > 255 || !/^[\x21-\x7e]+$/.test(t)) throw new RepoError(400, "personal access token looks malformed (20-255 printable characters, no spaces)");
  return t;
}

/** Sets (token) or clears (null) the repo's PAT. Same gate as edit/remove: the adder, team leads, the designated lead, admins. */
export function setRepoPat(db: DB, u: { id?: number; email?: string; role: string; tenantId: number }, repo: string, token: string | null, secretKey: string | undefined, now = Date.now()): TeamRepo {
  const r = teamRepo(db, u.tenantId, repo);
  if (!r) throw new RepoError(404, `${repo} is not registered`);
  if (!canManageRepos(u) && !(u.id != null && canEditRepo(db, { ...u, id: u.id }, r))) throw new RepoError(403, "only the repo's adder, team leads and admins can change its token");
  if (token === null) db.prepare("UPDATE team_repos SET pat_enc = NULL, pat_last4 = NULL, pat_set_at = NULL WHERE tenant_id = ? AND repo = ?").run(u.tenantId, r.repo);
  else {
    const t = cleanPat(token);
    let enc: string;
    try { enc = encryptSecret(t, secretKey); } catch (e) { throw new RepoError(503, e instanceof Error ? e.message : "encryption failed"); }
    db.prepare("UPDATE team_repos SET pat_enc = ?, pat_last4 = ?, pat_set_at = ? WHERE tenant_id = ? AND repo = ?").run(enc, t.slice(-4), now, u.tenantId, r.repo);
  }
  if (u.id != null) repoAudit(db, { ...u, id: u.id }, token === null ? "token_clear" : "token_set", r.repo, "", now);
  return teamRepo(db, u.tenantId, r.repo)!;
}

/** The repo's decrypted PAT, or undefined (not set, or undecryptable) so callers fall back to GITHUB_TOKEN. */
export function repoPat(db: DB, tenantId: number, repo: string, secretKey: string | undefined): string | undefined {
  const row = db.prepare("SELECT pat_enc AS e FROM team_repos WHERE tenant_id = ? AND lower(repo) = lower(?)").get(tenantId, repo) as { e: string | null } | undefined;
  if (!row?.e) return undefined;
  try { return decryptSecret(row.e, secretKey); } catch { return undefined; }
}

/** Token for a GitHub call on this repo: its PAT when set, else the server GITHUB_TOKEN. */
/** Token for a GitHub call on this repo: its PAT when set, else the server GITHUB_TOKEN (fallback).
 *  A PAT that is set but can't be decrypted gives no token (never a silent GITHUB_TOKEN fallback). */
export const tokenFor = (db: DB, tenantId: number, secretKey: string | undefined, fallback: string | undefined) =>
  (repo: string): string | undefined => {
    const row = db.prepare("SELECT pat_enc AS e FROM team_repos WHERE tenant_id = ? AND lower(repo) = lower(?)").get(tenantId, repo.trim()) as { e: string | null } | undefined;
    if (!row?.e) return fallback;
    try { return decryptSecret(row.e, secretKey); } catch {
      console.error(`[cobra] the stored token for ${repo} can't be decrypted (COBRA_SECRET_KEY changed?); not falling back to GITHUB_TOKEN`);
      return undefined;
    }
  };

/** Every decrypted PAT of the team, plus the forms git sees (for redaction). */
export function teamPatSecrets(db: DB, tenantId: number, secretKey: string | undefined): string[] {
  return listTeamRepos(db, tenantId).filter((r) => r.patSet).flatMap((r) => {
    const t = repoPat(db, tenantId, r.repo, secretKey);
    return t ? [t, Buffer.from(`x-access-token:${t}`).toString("base64")] : [];
  });
}

/** Checks a token against GET /repos/<repo>. Throws RepoError when GitHub rejects it; else reports push access. */
export async function verifyPat(repo: string, token: string, fetchImpl: typeof fetch = fetch): Promise<{ push: boolean | null }> {
  let r: Response;
  try {
    r = await fetchImpl(`https://api.github.com/repos/${repo.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cobra" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { return { push: null }; }
  if (r.status === 401) throw new RepoError(400, "GitHub rejected the token (401 bad credentials); not saved");
  if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") return { push: null };
  if (r.status === 403 || r.status === 404) throw new RepoError(400, `the token can't access ${repo} on GitHub (HTTP ${r.status}); not saved`);
  if (!r.ok) return { push: null };
  const j = (await r.json().catch(() => ({}))) as { permissions?: { push?: boolean } };
  return { push: typeof j.permissions?.push === "boolean" ? j.permissions.push : null };
}

function keyOrFail(secretKey: string | undefined) {
  try { parseKey(secretKey); } catch (e) { throw new RepoError(503, e instanceof SecretKeyError ? e.message : "COBRA_SECRET_KEY is invalid"); }
}

/** POST /api/repos. Any team member adds a repo to their own team with their own PAT (required for members;
 *  leads/admins may omit it and rely on GITHUB_TOKEN). The token is checked against GitHub before anything is saved. */
export async function addRepoWithToken(db: DB, u: RepoUser, b: { repo: string; defaultBranch?: string; pat?: string | null }, secretKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<TeamRepo & { pushAccess?: boolean | null }> {
  if (!canAddRepo(u)) throw new RepoError(403, "only team members can add repos");
  const pat = b.pat && b.pat.trim() ? b.pat : null;
  if (!pat && !canManageRepos(u)) throw new RepoError(400, "a GitHub personal access token with access to the repo is required");
  const repo = b.repo.trim();
  if (!REPO_RE.test(repo)) throw new RepoError(400, "repo must look like owner/name");
  if (teamRepo(db, u.tenantId, repo)) throw new RepoError(409, `${repo} is already registered`);
  let check: { push: boolean | null } | undefined;
  if (pat) { keyOrFail(secretKey); check = await verifyPat(repo, cleanPat(pat), fetchImpl); }
  let r = addTeamRepo(db, u, repo, b.defaultBranch);
  if (pat) r = setRepoPat(db, u, r.repo, pat, secretKey);
  return { ...r, ...(check ? { pushAccess: check.push } : {}) };
}

/** PATCH /api/repos token change: team scope (404) and permission (403) before GitHub is ever called. */
export async function changeRepoToken(db: DB, u: RepoUser, repo: string, pat: string | null, secretKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<TeamRepo & { pushAccess?: boolean | null }> {
  const r0 = teamRepo(db, u.tenantId, repo.trim());
  if (!r0) throw new RepoError(404, `${repo} is not registered`);
  if (!canManageRepos(u) && !canEditRepo(db, u, r0)) throw new RepoError(403, "only the repo's adder, team leads and admins can change its token");
  if (pat === null || !pat.trim()) return setRepoPat(db, u, r0.repo, null, secretKey);
  keyOrFail(secretKey);
  const check = await verifyPat(r0.repo, cleanPat(pat), fetchImpl);
  return { ...setRepoPat(db, u, r0.repo, pat, secretKey), pushAccess: check.push };
}
