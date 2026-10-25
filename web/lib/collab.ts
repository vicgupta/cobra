// Issues and pull requests for a team's repos (docs/workflow-redesign.md, "Issues and
// pull requests"). Any team member creates issues, agent issues and PRs without approval;
// only the team's designated lead or a system admin (role admin) may merge. Every
// action is written to collab_audit. Kept free of Next so tests can drive it.
import type { DB } from "./db";
import { checkTeamRepo, teamRepo } from "./repos";
import { getAgent } from "./agents";
import { GitHubApiError, type GitHub } from "./github-api";
import { runDirect, type RunDeps } from "./workflows/service";
import type { Actor } from "./workflows/store";

export class CollabError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export type AuditAction = "issue_create" | "agent_issue" | "pr_create" | "comment" | "merge";
export type AuditRow = { id: number; actorEmail: string; action: AuditAction; repo: string; number: number | null; runId: string | null; detail: string; at: number };

/** "Admin" is the system admin (role admin); there is no team-admin role. */
export const isSystemAdmin = (u: { role: string }) => u.role === "admin";

export function designatedLead(db: DB, tenantId: number): { id: number; email: string } | null {
  const r = db.prepare("SELECT u.id, u.email FROM tenants t JOIN users u ON u.id = t.designated_lead_user_id WHERE t.id = ?").get(tenantId) as { id: number; email: string } | undefined;
  return r ? { id: r.id, email: r.email } : null;
}

export function teamLeads(db: DB, tenantId: number): Array<{ id: number; email: string; name: string }> {
  return (db.prepare("SELECT id, email, coalesce(name, '') AS name FROM users WHERE tenant_id = ? AND role = 'team_lead' ORDER BY email").all(tenantId) as Array<{ id: number; email: string; name: string }>).map((r) => ({ id: r.id, email: r.email, name: r.name }));
}

/** Merge rights: the team's designated lead (still a team lead) or a system admin. */
export function canMerge(db: DB, u: Actor): boolean {
  if (isSystemAdmin(u)) return true;
  const d = designatedLead(db, u.tenantId);
  return !!d && d.id === u.id && u.role === "team_lead";
}

/** Only system admins pick the designated lead, from the team's team leads (null clears it). */
export function setDesignatedLead(db: DB, u: Actor, userId: number | null): { id: number; email: string } | null {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can choose the designated lead");
  if (userId !== null && !teamLeads(db, u.tenantId).some((l) => l.id === userId)) throw new CollabError(400, "the designated lead must be one of this team's team leads");
  db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(userId, u.tenantId);
  return designatedLead(db, u.tenantId);
}

export function audit(db: DB, u: Actor, action: AuditAction, repo: string, number: number | null, runId: string | null = null, detail = "", now = Date.now()): void {
  db.prepare("INSERT INTO collab_audit (tenant_id, actor_id, actor_email, action, repo, number, run_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, u.id, u.email, action, repo, number, runId, detail.slice(0, 500), now);
}

export function listAudit(db: DB, tenantId: number, repo: string, number?: number): AuditRow[] {
  const rows = (number === undefined
    ? db.prepare("SELECT * FROM collab_audit WHERE tenant_id = ? AND lower(repo) = lower(?) ORDER BY at DESC, id DESC LIMIT 200").all(tenantId, repo)
    : db.prepare("SELECT * FROM collab_audit WHERE tenant_id = ? AND lower(repo) = lower(?) AND number = ? ORDER BY at DESC, id DESC").all(tenantId, repo, number)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: r.id as number, actorEmail: r.actor_email as string, action: r.action as AuditAction, repo: r.repo as string, number: (r.number as number | null) ?? null, runId: (r.run_id as string | null) ?? null, detail: r.detail as string, at: r.at as number }));
}

/** Team repos only (plus the optional global ceiling). */
export function repoGate(db: DB, u: Actor, repo: string): string {
  const d = checkTeamRepo(db, u.tenantId, repo);
  if (d) throw new CollabError(d.includes("not registered") ? 404 : 400, d);
  return teamRepo(db, u.tenantId, repo)?.repo ?? repo;
}

const text = (v: unknown, name: string, max: number, required = true): string => {
  if (v === undefined || v === null || v === "") { if (required) throw new CollabError(400, `${name} is required`); return ""; }
  if (typeof v !== "string") throw new CollabError(400, `${name} must be text`);
  const s = v.trim();
  if (required && !s) throw new CollabError(400, `${name} is required`);
  if (s.length > max) throw new CollabError(400, `${name} must be at most ${max} characters`);
  return s;
};
const num = (n: unknown) => { const v = Number(n); if (!Number.isInteger(v) || v <= 0) throw new CollabError(400, "invalid number"); return v; };
const footer = (u: Actor, extra = "") => `\n\n---\n_Created with Cobra by ${u.email}${extra}_`;

export async function createIssue(db: DB, gh: GitHub, u: Actor, repo: string, body: unknown) {
  repo = repoGate(db, u, repo);
  const b = (body ?? {}) as Record<string, unknown>;
  const issue = await gh.createIssue(repo, text(b.title, "title", 256), text(b.body, "body", 60000, false) + footer(u));
  audit(db, u, "issue_create", repo, issue.number, null, issue.title);
  return issue;
}

export async function addComment(db: DB, gh: GitHub, u: Actor, repo: string, number: unknown, body: unknown) {
  repo = repoGate(db, u, repo);
  const n = num(number);
  const c = await gh.comment(repo, n, text((body as Record<string, unknown> | null)?.body, "body", 60000) + footer(u));
  audit(db, u, "comment", repo, n, null, c.html_url);
  return c;
}

/** Engine or team agent from the request: { agent } or { engine, prompt }. */
function pickAgent(db: DB, u: Actor, b: Record<string, unknown>, basePrompt: string) {
  if (typeof b.agent === "string" && b.agent) {
    const a = getAgent(db, u.tenantId, b.agent);
    if (!a) throw new CollabError(404, `agent '${b.agent}' not found`);
    return { agent: a.name, engine: a.engine, prompt: `${a.prompt}\n\nAdditional instructions:\n${basePrompt}`, hash: a.contentHash };
  }
  const engine = b.engine ?? "claude-code";
  if (engine !== "claude-code" && engine !== "codex") throw new CollabError(400, "engine must be claude-code or codex");
  return { engine, prompt: basePrompt };
}

type Started = { runId: string; followUp: Promise<void> };

/** Run an agent; when it succeeds its output becomes a new issue (no approval needed). */
export function agentIssue(db: DB, gh: GitHub, u: Actor, repo: string, body: unknown, deps: RunDeps): Started {
  repo = repoGate(db, u, repo);
  const b = (body ?? {}) as Record<string, unknown>;
  const ask = text(b.prompt, "prompt", 20000);
  const title = text(b.title, "title", 256, false);
  const pick = pickAgent(db, u, b, `${ask}\n\nReply with a GitHub issue: the first line is a short title, then a markdown body. Do not change any files.`);
  const r = runDirect(db, u, { ...pick, repo, mode: b.mode ?? "simulated", purpose: `Agent-written issue for ${repo}` }, deps);
  if (!r.run) throw new CollabError(r.status, (r.body as { error: string }).error);
  const runId = r.run.id;
  const followUp = r.run.done.then(async (res) => {
    if (res.status !== "succeeded") return;
    const out = String(res.outputs.summary ?? "").trim() || "(the agent returned no text)";
    const [first, ...rest] = out.split("\n");
    const t = (title || first.replace(/^#+\s*/, "").trim() || `Issue from ${pick.agent ?? pick.engine}`).slice(0, 200);
    const issue = await gh.createIssue(repo, t, (title ? out : rest.join("\n").trim() || out) + footer(u, ` via ${pick.agent ? `agent ${pick.agent}` : pick.engine}, run ${runId}`));
    audit(db, u, "agent_issue", repo, issue.number, runId, issue.title);
  }).catch((e) => console.error(`[cobra] agent issue for run ${runId} failed:`, e instanceof Error ? e.message : e));
  return { runId, followUp };
}

/** "Create PR" on an issue: a real agent run on cobra/<run-id>, then a PR that references the issue. */
export async function createPrFromIssue(db: DB, gh: GitHub, u: Actor, repo: string, number: unknown, body: unknown, deps: RunDeps): Promise<Started> {
  repo = repoGate(db, u, repo);
  const n = num(number);
  const b = (body ?? {}) as Record<string, unknown>;
  const extra = text(b.instructions, "instructions", 4000, false);
  const issue = await gh.getIssue(repo, n);
  if (issue.pull_request) throw new CollabError(400, `#${n} is a pull request, not an issue`);
  const task = `Resolve GitHub issue #${n} in ${repo}.\n\nTitle: ${issue.title}\n\n${issue.body ?? ""}`.trim() + (extra ? `\n\nAdditional instructions:\n${extra}` : "") + "\n\nMake the code change in this repository and finish with a short summary of what you changed.";
  const pick = pickAgent(db, u, b, task);
  const r = runDirect(db, u, { ...pick, repo, mode: "real", purpose: `PR for ${repo}#${n}` }, deps);
  if (!r.run) throw new CollabError(r.status, (r.body as { error: string }).error);
  const runId = r.run.id;
  const followUp = r.run.done.then(async (res) => {
    if (res.status !== "succeeded") return;
    const branch = String(res.outputs.branch ?? "");
    if (String(res.outputs.pushed) !== "true" || !branch) { console.error(`[cobra] run ${runId} pushed no branch; no PR for ${repo}#${n}`); return; }
    const base = teamRepo(db, u.tenantId, repo)?.defaultBranch || (await gh.repoInfo(repo)).default_branch;
    const summary = String(res.outputs.summary ?? "").trim().slice(0, 4000);
    const pr = await gh.createPull(repo, { title: `${issue.title} (#${n})`.slice(0, 250), head: branch, base, body: `Closes #${n}\n\n${summary}${footer(u, ` via ${pick.agent ? `agent ${pick.agent}` : pick.engine}, run ${runId}`)}` });
    audit(db, u, "pr_create", repo, pr.number, runId, `for #${n}`);
    audit(db, u, "pr_create", repo, n, runId, `PR #${pr.number}`);
  }).catch((e) => console.error(`[cobra] PR for run ${runId} failed:`, e instanceof Error ? e.message : e));
  return { runId, followUp };
}

/** Merge: enforced here (designated lead or system admin), plain merge pinned to the head sha. */
export async function mergePull(db: DB, gh: GitHub, u: Actor, repo: string, number: unknown) {
  repo = repoGate(db, u, repo);
  const n = num(number);
  if (!canMerge(db, u)) throw new CollabError(403, "only the team's designated lead or a system admin can merge");
  const pr = await gh.getPull(repo, n);
  if (pr.state !== "open" || pr.merged) throw new CollabError(409, `#${n} is not open`);
  try {
    const m = await gh.merge(repo, n, pr.head.sha);
    audit(db, u, "merge", repo, n, null, `${pr.head.ref} into ${pr.base.ref} @ ${m.sha.slice(0, 12)}`);
    return { merged: m.merged, sha: m.sha, base: pr.base.ref };
  } catch (e) {
    if (e instanceof GitHubApiError) throw new CollabError(e.status === 403 || e.status === 404 ? 502 : e.status, e.message);
    throw e;
  }
}
