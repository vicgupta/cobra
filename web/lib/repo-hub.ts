// Repos section (Overview, Branches, Activity): read-only views built from team_repos,
// runs, run_step_events and collab_audit, plus GitHub reads through the per-repo token.
import type { DB } from "./db";
import { RepoError, REPO_RE } from "./repos";

/** The Cobra app's own repo: its branches are system-only and never listed to anyone. */
export const COBRA_APP_REPO = "vicgupta/cobra";
const isAdmin = (u: { role: string }) => u.role === "admin";
const lc = (s: string) => s.toLowerCase();

/**
 * Repos whose branches a user may list: every repo on their team's list (whoever added it);
 * system admins also see other teams' repos. The Cobra app repo is excluded for every role.
 */
export function branchRepos(db: DB, u: { role: string; tenantId: number }): string[] {
  const rows = (isAdmin(u)
    ? db.prepare("SELECT repo FROM team_repos ORDER BY tenant_id = ? DESC, repo").all(u.tenantId)
    : db.prepare("SELECT repo FROM team_repos WHERE tenant_id = ? ORDER BY repo").all(u.tenantId)) as Array<{ repo: string }>;
  const seen = new Set<string>();
  return rows.map((r) => r.repo).filter((r) => lc(r) !== COBRA_APP_REPO && !seen.has(lc(r)) && !!seen.add(lc(r)));
}

/** Server-side gate for one repo's branches: 400 bad name, 403 Cobra app repo, 404 not on the list. */
export function branchRepoGate(db: DB, u: { role: string; tenantId: number }, repo: string): string {
  if (!REPO_RE.test(repo)) throw new RepoError(400, "repo must look like owner/name");
  if (lc(repo) === COBRA_APP_REPO) throw new RepoError(403, "branches of the Cobra app repo are not shown");
  const hit = branchRepos(db, u).find((r) => lc(r) === lc(repo));
  if (!hit) throw new RepoError(404, `repo ${repo} is not on your team's list`);
  return hit;
}

/** Cobra's own working branches (cobra/<run-id>) are system-only: drop them from any listing. */
export const isCobraBranch = (name: string) => lc(name).startsWith("cobra/");
export const visibleBranches = <T extends { name: string }>(bs: T[]) => bs.filter((b) => !isCobraBranch(b.name));

export type RunRef = { id: string; status: string | null; title: string; startedAt: number };

export function lastRun(db: DB, tenantId: number, repo: string): RunRef | null {
  const r = db.prepare("SELECT id, status, title, started_at AS startedAt FROM runs WHERE tenant_id = ? AND lower(repo) = lower(?) ORDER BY started_at DESC LIMIT 1").get(tenantId, repo) as RunRef | undefined;
  return r ? { id: r.id, status: r.status, title: r.title, startedAt: r.startedAt } : null;
}

export type ActivityItem = { at: number; kind: "audit" | "run" | "step"; repo: string; label: string; actor: string | null; runId: string | null; status: string | null };

/** Combined feed for the team's repos (optionally one repo), newest first. */
export function activityFeed(db: DB, tenantId: number, repo?: string, limit = 100): ActivityItem[] {
  const f = repo ? " AND lower(x.repo) = lower(?)" : "";
  const a = repo ? [tenantId, repo] : [tenantId];
  const team = "lower(x.repo) IN (SELECT lower(repo) FROM team_repos WHERE tenant_id = x.tenant_id)";
  type R = Record<string, unknown>;
  const audit = db.prepare(`SELECT x.at, x.repo, x.action, x.actor_email, x.run_id, x.number, x.detail FROM collab_audit x WHERE x.tenant_id = ? AND ${team}${f} ORDER BY x.at DESC LIMIT ${limit}`).all(...a) as R[];
  const runs = db.prepare(`SELECT x.started_at AS at, x.repo, x.id, x.title, x.status, u.email FROM runs x LEFT JOIN users u ON u.id = x.created_by WHERE x.tenant_id = ? AND ${team}${f} ORDER BY x.started_at DESC LIMIT ${limit}`).all(...a) as R[];
  const steps = db.prepare(`SELECT e.at, x.repo, x.id, e.step_id, e.status FROM run_step_events e JOIN runs x ON x.id = e.run_id WHERE x.tenant_id = ? AND e.status IN ('succeeded','failed') AND ${team}${f} ORDER BY e.at DESC LIMIT ${limit}`).all(...a) as R[];
  const ACT: Record<string, string> = { issue_create: "Issue created", agent_issue: "Agent wrote issue", pr_create: "PR created", comment: "Comment", merge: "Merged" };
  const items: ActivityItem[] = [
    ...audit.map((r) => ({ at: Number(r.at), kind: "audit" as const, repo: String(r.repo), label: `${ACT[String(r.action)] ?? String(r.action)}${r.number ? ` #${String(r.number)}` : ""}${r.detail ? ` · ${String(r.detail)}` : ""}`, actor: String(r.actor_email), runId: (r.run_id as string | null) ?? null, status: null })),
    ...runs.map((r) => ({ at: Number(r.at), kind: "run" as const, repo: String(r.repo), label: `Run started: ${String(r.title)}`, actor: (r.email as string | null) ?? null, runId: String(r.id), status: (r.status as string | null) ?? null })),
    ...steps.map((r) => ({ at: Number(r.at), kind: "step" as const, repo: String(r.repo), label: `Step ${String(r.step_id)} ${String(r.status)}`, actor: null, runId: String(r.id), status: String(r.status) })),
  ];
  return items.sort((x, y) => y.at - x.at).slice(0, limit);
}
