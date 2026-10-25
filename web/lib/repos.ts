// Per-team GitHub repo registry. The single gate for every GitHub read, write and
// run: a repo must be registered to the acting team and, if COBRA_GITHUB_ALLOWED_REPOS
// is set, also be in that global ceiling.
import type { DB } from "./db";
import { decryptSecret, encryptSecret } from "./secret-box";

/** patSet/patLast4 only: the token itself never leaves the server. */
export type TeamRepo = { repo: string; defaultBranch: string | null; createdAt: number; patSet: boolean; patLast4: string | null };
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function listTeamRepos(db: DB, tenantId: number): TeamRepo[] {
  type Row = { repo: string; defaultBranch: string | null; createdAt: number; patSet: number; patLast4: string | null };
  return (db.prepare("SELECT repo, default_branch AS defaultBranch, created_at AS createdAt, pat_enc IS NOT NULL AS patSet, pat_last4 AS patLast4 FROM team_repos WHERE tenant_id = ? ORDER BY repo").all(tenantId) as unknown as Row[])
    // node:sqlite rows have a null prototype, which React can't pass to Client Components.
    .map((r) => ({ repo: r.repo, defaultBranch: r.defaultBranch, createdAt: r.createdAt, patSet: !!r.patSet, patLast4: r.patSet ? r.patLast4 : null }));
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
  if (!canManageRepos(u)) throw new RepoError(403, "only admins and team leads can manage repos");
  repo = repo.trim();
  if (!REPO_RE.test(repo)) throw new RepoError(400, "repo must look like owner/name");
  const b = defaultBranch?.trim() || null;
  if (b && !/^[\w./-]+$/.test(b)) throw new RepoError(400, "invalid branch name");
  if (teamRepo(db, u.tenantId, repo)) throw new RepoError(409, `${repo} is already registered`);
  db.prepare("INSERT INTO team_repos (tenant_id, repo, default_branch, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(u.tenantId, repo, b, u.id, now);
  return { repo, defaultBranch: b, createdAt: now, patSet: false, patLast4: null };
}

export function removeTeamRepo(db: DB, u: { role: string; tenantId: number }, repo: string): void {
  if (!canManageRepos(u)) throw new RepoError(403, "only admins and team leads can manage repos");
  const r = db.prepare("DELETE FROM team_repos WHERE tenant_id = ? AND lower(repo) = lower(?)").run(u.tenantId, repo);
  if (!r.changes) throw new RepoError(404, `${repo} is not registered`);
}

// ---- Per-repo GitHub PAT (Job 19). Encrypted with COBRA_SECRET_KEY; falls back to GITHUB_TOKEN when unset.

/** Trimmed token, or a RepoError for an obviously malformed one. */
export function cleanPat(token: string): string {
  const t = token.trim();
  if (t.length < 20 || t.length > 255 || !/^[\x21-\x7e]+$/.test(t)) throw new RepoError(400, "personal access token looks malformed (20-255 printable characters, no spaces)");
  return t;
}

/** Sets (token) or clears (null) the repo's PAT. Same gate as add/remove. */
export function setRepoPat(db: DB, u: { role: string; tenantId: number }, repo: string, token: string | null, secretKey: string | undefined, now = Date.now()): TeamRepo {
  if (!canManageRepos(u)) throw new RepoError(403, "only admins and team leads can manage repo tokens");
  const r = teamRepo(db, u.tenantId, repo);
  if (!r) throw new RepoError(404, `${repo} is not registered`);
  if (token === null) db.prepare("UPDATE team_repos SET pat_enc = NULL, pat_last4 = NULL, pat_set_at = NULL WHERE tenant_id = ? AND repo = ?").run(u.tenantId, r.repo);
  else {
    const t = cleanPat(token);
    let enc: string;
    try { enc = encryptSecret(t, secretKey); } catch (e) { throw new RepoError(503, e instanceof Error ? e.message : "encryption failed"); }
    db.prepare("UPDATE team_repos SET pat_enc = ?, pat_last4 = ?, pat_set_at = ? WHERE tenant_id = ? AND repo = ?").run(enc, t.slice(-4), now, u.tenantId, r.repo);
  }
  return teamRepo(db, u.tenantId, r.repo)!;
}

/** The repo's decrypted PAT, or undefined (not set, or undecryptable) so callers fall back to GITHUB_TOKEN. */
export function repoPat(db: DB, tenantId: number, repo: string, secretKey: string | undefined): string | undefined {
  const row = db.prepare("SELECT pat_enc AS e FROM team_repos WHERE tenant_id = ? AND lower(repo) = lower(?)").get(tenantId, repo) as { e: string | null } | undefined;
  if (!row?.e) return undefined;
  try { return decryptSecret(row.e, secretKey); } catch { return undefined; }
}

/** Token for a GitHub call on this repo: its PAT when set, else the server GITHUB_TOKEN. */
export const tokenFor = (db: DB, tenantId: number, secretKey: string | undefined, fallback: string | undefined) =>
  (repo: string): string | undefined => repoPat(db, tenantId, repo, secretKey) ?? fallback;

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
