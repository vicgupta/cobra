// Route logic for the workflow API, kept free of Next so tests can exercise the
// permission checks directly. Each function returns { status, body }.
import { createHash } from "node:crypto";
import type { DB } from "../db";
import { approvalState, canApprove, PermissionError, recordDecision, selfApprovalPolicy } from "./approvals";
import { InputError, resolveInputs, WorkflowNotApprovedError, type Handlers } from "./engine";
import { interpolate } from "./expr";
import { ENGINES, type Engine } from "./schema";
import { ENGINE_LIST, isEngine, UNSUPPORTED_ENGINE } from "../engines";
import { checkTeamRepo, listTeamRepos } from "../repos";
import type { LoadedWorkflow } from "./loader";
import { canViewRun, getRunDetail, hasAgentStep, listWorkflowRuns, startWorkflowRun, type RunMeta } from "./runner";
import { attachedRepo, canEdit, canRun, findWorkflow, freeName, instancesOf, listAll, saveTenantWorkflow, SaveError, storageOf, syncFromGitHub, systemTemplates, templateCopySource, type Actor, type Storage } from "./store";
import type { GitHubFiles } from "./github-files";
import { finalPrompt, getAgent } from "../agents";
import type { Workflow } from "./schema";

export type Res = { status: number; body: unknown };
const ok = (body: unknown, status = 200): Res => ({ status, body });
const err = (status: number, error: string, errors?: string[]): Res => ({ status, body: { error, ...(errors ? { errors } : {}) } });

export type RunDeps = { github?: GitHubFiles; handlers: Handlers; resolveSecret: (name: string) => string | undefined; redact: () => string[]; dir?: string };

function summary(db: DB, user: Actor, w: LoadedWorkflow) {
  const wf = w.workflow, st = approvalState(db, user.tenantId, w);
  return {
    name: wf.name, version: wf.version, description: wf.description, origin: w.origin, system: wf.system, template: wf.template,
    hash: w.hash, owner: wf.governance.owner, author: w.author ?? null,
    approvers: wf.governance.approvers.map((a) => (typeof a === "string" ? a : `role:${a.role}`)),
    reviewers: wf.governance.reviewers, minApprovals: wf.governance.min_approvals,
    approval: { status: st.status, reason: st.reason },
    engine: wf.engine ?? "claude-code",
    triggers: Object.keys(wf.on).filter((k) => (wf.on as Record<string, unknown>)[k]),
  };
}

export const STATUS_FILTERS = ["all", "approved", "pending", "rejected"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
/** Validates ?status= server-side; anything unknown or missing is "all". */
export function parseStatusFilter(v: unknown): StatusFilter {
  const raw = Array.isArray(v) ? v[0] : v;
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return (STATUS_FILTERS as readonly string[]).includes(s) ? (s as StatusFilter) : "all";
}
type WithStatus = { approval?: { status: string } };
/** Same status as the badge (approvalState for the current content hash). Same for every role. */
export function filterByStatus<T extends WithStatus>(rows: T[], status: StatusFilter): T[] {
  return status === "all" ? rows : rows.filter((r) => r.approval?.status === status);
}
export function statusCounts(rows: WithStatus[]): Record<StatusFilter, number> {
  return Object.fromEntries(STATUS_FILTERS.map((f) => [f, filterByStatus(rows, f).length])) as Record<StatusFilter, number>;
}

export function listWorkflowsFor(db: DB, user: Actor, dir?: string, opts: { status?: StatusFilter } = {}): Res {
  const rows = listAll(db, user.tenantId, dir).map((l) => (l.loaded ? summary(db, user, l.loaded) : { name: l.name, origin: l.origin, errors: l.errors })) as Array<WithStatus & { name: string }>;
  return ok(filterByStatus(rows, opts.status ?? "all"));
}

export function workflowDetail(db: DB, user: Actor, name: string, dir?: string): Res {
  const w = findWorkflow(db, user.tenantId, name, dir);
  if (!w) return err(404, `workflow '${name}' not found`);
  const st = approvalState(db, user.tenantId, w);
  return ok({
    ...summary(db, user, w),
    source: w.source,
    inputs: w.workflow.inputs,
    steps: w.workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, uses: s.uses, needs: s.needs, if: s.if ?? null, secrets: s.secrets, agent: typeof s.with.agent === "string" ? s.with.agent : null })),
    outputs: Object.keys(w.workflow.outputs),
    decisions: st.decisions.map((d) => ({ email: d.email, role: d.role, decision: d.decision, comment: d.comment, createdAt: d.createdAt })),
    selfApprovalPolicy: selfApprovalPolicy(),
    can: {
      approve: !w.workflow.template && w.origin !== "template" && canApprove(user, w.workflow.governance),
      edit: canEdit(user, w),
      run: canRun(user, w) && st.status === "approved",
    },
    runs: w.workflow.template ? [] : listWorkflowRuns(db, user.tenantId, name),
    storage: w.origin === "tenant" ? storageOf(db, user.tenantId, name) : { kind: w.origin === "template" ? "repo+database" : "repo" },
    instances: w.workflow.template ? instancesOf(db, user.tenantId, name).map((i) => ({ ...i, fromCurrentVersion: i.templateHash === w.hash })) : [],
    engine: w.workflow.engine ?? "claude-code",
    prompt: w.workflow.prompt ?? null,
    repo: w.origin === "tenant" ? attachedRepo(db, user.tenantId, name) : null,
    teamRepos: listTeamRepos(db, user.tenantId).map((r) => r.repo),
    hasAgentStep: hasAgentStep(w.workflow),
    sourceHash: w.sourceHash ?? w.hash,
    agents: Object.entries(w.agents ?? {}).map(([name, a]) => ({ name, engine: a.engine, hash: a.hash })),
    agentErrors: w.agentErrors ?? [],
    createdFrom: w.origin === "tenant" ? ({ ...(db.prepare("SELECT template_name AS name, template_hash AS hash FROM tenant_workflows WHERE tenant_id = ? AND name = ?").get(user.tenantId, name) as { name: string | null; hash: string | null }) }) : null,
  });
}

type SaveBody = { source?: unknown; previousName?: unknown; templateName?: unknown; repo?: unknown; storage?: unknown; github?: { repo?: unknown; path?: unknown; branch?: unknown } | null; import?: unknown };
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function saveWorkflow(db: DB, user: Actor, body: SaveBody | null, deps: { github?: GitHubFiles; dir?: string } = {}): Promise<Res> {
  if (!body) return err(400, "invalid JSON body");
  const imp = body.import === true;
  if (!imp && typeof body.source !== "string") return err(400, "source (YAML text) is required");
  let storage: Storage | undefined;
  if (body.storage === "github") {
    const repo = str(body.github?.repo), path = str(body.github?.path);
    if (!repo || !path) return err(400, "GitHub storage needs a repo (owner/name) and a file path");
    storage = { kind: "github", repo, path, branch: str(body.github?.branch) };
  } else if (body.storage === "database") storage = { kind: "database" };
  else if (body.storage !== undefined) return err(400, "storage must be database or github");
  try {
    const w = await saveTenantWorkflow(db, user, typeof body.source === "string" ? body.source : "", {
      previousName: str(body.previousName), templateName: str(body.templateName), repo: str(body.repo), storage, github: deps.github, importExisting: imp, dir: deps.dir,
    });
    // Re-read so the summary carries the effective hash (team agents folded in).
    return ok(summary(db, user, findWorkflow(db, user.tenantId, w.workflow.name, deps.dir) ?? w), body.previousName ? 200 : 201);
  } catch (e) {
    if (e instanceof SaveError) return err(e.status, e.errors[0], e.errors);
    throw e;
  }
}

export async function syncWorkflow(db: DB, user: Actor, name: string, github: GitHubFiles): Promise<Res> {
  try {
    const r = await syncFromGitHub(db, user, name, github);
    return ok({ changed: r.changed, hash: r.loaded.hash });
  } catch (e) {
    if (e instanceof SaveError) return err(e.status, e.errors[0], e.errors);
    throw e;
  }
}

export function templateCopy(db: DB, user: Actor, name: string, dir?: string): Res {
  const t = systemTemplates(db).find((x) => x.workflow.name === name) ?? findWorkflow(db, user.tenantId, name, dir);
  if (!t || !t.workflow.template) return err(404, `template '${name}' not found`);
  return ok({ source: templateCopySource(t, user, freeName(db, user.tenantId, `${name}-copy`, dir)), templateName: name });
}

export function decide(db: DB, user: Actor, name: string, body: { decision?: unknown; comment?: unknown } | null, dir?: string): Res {
  const w = findWorkflow(db, user.tenantId, name, dir);
  if (!w) return err(404, `workflow '${name}' not found`);
  if (body?.decision !== "approve" && body?.decision !== "reject") return err(400, "decision must be approve or reject");
  try {
    const st = recordDecision(db, user, w, body.decision, typeof body.comment === "string" ? body.comment : "");
    return ok({ status: st.status, reason: st.reason, hash: st.hash });
  } catch (e) {
    if (e instanceof PermissionError) return err(403, e.message);
    throw e;
  }
}

export type StartBody = { inputs?: unknown; engine?: unknown; promptMode?: unknown; prompt?: unknown; repo?: unknown; mode?: unknown };

/** Resolves engine / prompt / repo / mode for a run: workflow defaults, overridable per run. */
/** Agent fields for a run. Workflows without a `uses: agent` step ignore repo/engine/mode/prompt in the request (meta: null). */
export function resolveRunMeta(db: DB, user: Actor, w: LoadedWorkflow, body: StartBody | null, inputs: Record<string, string | number | boolean>): { meta?: RunMeta | null; error?: string } {
  if (!hasAgentStep(w.workflow)) return { meta: null };
  const b = body ?? {};
  const engine = (str(b.engine) ?? w.workflow.engine ?? "claude-code") as Engine;
  if (!ENGINES.includes(engine)) return { error: `engine must be one of ${ENGINES.join(", ")}` };
  const mode = str(b.mode) ?? "simulated";
  if (mode !== "simulated" && mode !== "real") return { error: "mode must be simulated or real" };
  const templ = w.workflow.prompt;
  const wantMode = str(b.promptMode) ?? (str(b.prompt) !== undefined ? "custom" : templ ? "workflow" : "none");
  let prompt = "", promptSource: RunMeta["promptSource"];
  if (wantMode === "custom") {
    prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!prompt) return { error: "a free-form prompt is required when promptMode is custom" };
    if (prompt.length > 20000) return { error: "prompt must be at most 20000 characters" };
    promptSource = "custom";
  } else if (wantMode === "workflow") {
    if (!templ) return { error: "this workflow has no prompt template; enter a free-form prompt" };
    prompt = String(interpolate({ inputs, run: { engine } }, templ));
    promptSource = "workflow";
  } else if (wantMode === "none") promptSource = "none";
  else return { error: "promptMode must be workflow, custom or none" };
  const repo = str(b.repo) ?? (w.origin === "tenant" ? attachedRepo(db, user.tenantId, w.workflow.name) ?? undefined : undefined) ?? (typeof inputs.repo === "string" && inputs.repo ? inputs.repo : undefined);
  if (repo) { const d = checkTeamRepo(db, user.tenantId, repo); if (d) return { error: d }; }
  // Steps that use a team agent bring their own prompt; only plain agent steps need the run prompt.
  if (mode === "real" && !prompt && w.workflow.steps.some((s) => s.uses === "agent" && s.with.agent === undefined)) return { error: "a real run needs a prompt" };
  return { meta: { engine, prompt, promptSource, mode, repo } };
}

export function startRun(db: DB, user: Actor, name: string, body: StartBody | null, deps: RunDeps, extra: { idPrefix?: string } = {}): Res & { run?: ReturnType<typeof startWorkflowRun> } {
  const w = findWorkflow(db, user.tenantId, name, deps.dir);
  if (!w) return err(404, `workflow '${name}' not found`);
  if (!canRun(user, w)) return err(403, w.workflow.template ? "templates can't be run; copy one into a workflow first" : "you can't run this workflow");
  if (w.agentErrors?.length) return err(400, w.agentErrors[0], w.agentErrors);
  const raw = body?.inputs && typeof body.inputs === "object" ? (body.inputs as Record<string, unknown>) : {};
  try {
    const inputs = resolveInputs(w.workflow, raw);
    const r = resolveRunMeta(db, user, w, body, inputs);
    if (r.error) return err(400, r.error);
    const meta = r.meta ?? undefined;
    const run = startWorkflowRun(db, { tenantId: user.tenantId, userId: user.id }, w, raw,
      { handlers: deps.handlers, resolveSecret: deps.resolveSecret, redact: deps.redact(), idPrefix: extra.idPrefix, meta, inputs });
    return { ...ok({ id: run.id, startedAt: run.startedAt, inputs: run.inputs, workflow: name, engine: meta?.engine ?? null, promptSource: meta?.promptSource ?? null, mode: meta?.mode ?? null, repo: meta?.repo ?? null }, 201), run };
  } catch (e) {
    if (e instanceof WorkflowNotApprovedError) return err(409, e.message);
    if (e instanceof InputError) return err(400, e.errors[0], e.errors);
    throw e;
  }
}

/** Creates a team workflow instance from a template (system or team), attached to a team repo. */
export async function attachTemplate(db: DB, user: Actor, body: { template?: unknown; name?: unknown; repo?: unknown } | null, deps: { github?: GitHubFiles; dir?: string } = {}): Promise<Res> {
  const tname = str(body?.template), repo = str(body?.repo);
  if (!tname) return err(400, "template is required");
  if (!repo) return err(400, "repo is required");
  const t = findWorkflow(db, user.tenantId, tname, deps.dir);
  if (!t || !t.workflow.template) return err(404, `template '${tname}' not found`);
  const d = checkTeamRepo(db, user.tenantId, repo);
  if (d) return err(400, d);
  const base = str(body?.name) ?? `${tname.replace(/-template$/, "")}-${repo.split("/")[1]}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 60);
  const name = str(body?.name) ?? freeName(db, user.tenantId, base, deps.dir);
  return saveWorkflow(db, user, { source: templateCopySource(t, user, name), templateName: tname, repo }, deps);
}

export function runDetailFor(db: DB, user: Actor, id: string): Res {
  const r = getRunDetail(db, id);
  // 404 (not 403) for other users' runs so ids can't be probed.
  if (!r || !canViewRun(user, r)) return err(404, "run not found");
  return ok(r);
}

export type AgentRunBody = { repo?: unknown; mode?: unknown; instructions?: unknown };

/**
 * A direct run of one team agent: no workflow approval (any team member may run
 * the team's agents), engine fixed by the agent, repo from the team's list
 * (default: the agent's default_repo), optional extra instructions appended to
 * its prompt. Real runs use the local runner and push to cobra/<run-id>.
 */
export function runAgent(db: DB, user: Actor, name: string, body: AgentRunBody | null, deps: RunDeps): Res & { run?: ReturnType<typeof startWorkflowRun> } {
  const a = getAgent(db, user.tenantId, name);
  if (!a) return err(404, `agent '${name}' not found`);
  if (!isEngine(a.engine)) return err(400, `agent '${name}' uses ${a.engine}: ${UNSUPPORTED_ENGINE} (this build runs Claude Code or Codex only)`);
  if (a.skillRef) return err(400, `agent '${name}' runs a skill; start it from the Agents page (lib/agent-run.ts runTeamAgent)`);
  const b = body ?? {};
  if (b.instructions !== undefined && typeof b.instructions !== "string") return err(400, "instructions must be text");
  const extra = typeof b.instructions === "string" ? b.instructions.trim() : "";
  if (extra.length > 4000) return err(400, "instructions must be at most 4000 characters");
  return runDirect(db, user, { agent: a.name, engine: a.engine, model: a.model, prompt: finalPrompt(a.prompt, extra), hash: a.contentHash, repo: str(b.repo) ?? a.defaultRepo ?? undefined, mode: b.mode }, deps);
}

/** A pre-approved single agent step: a team agent (agent set) or a plain engine + prompt. */
export function runDirect(db: DB, user: Actor, o: { agent?: string; engine: string; model?: string | null; prompt: string; hash?: string; repo?: string; mode?: unknown; purpose?: string; scheduled?: boolean; triggeredBy?: string }, deps: RunDeps): Res & { run?: ReturnType<typeof startWorkflowRun> } {
  const mode = str(o.mode) ?? "simulated";
  if (mode !== "simulated" && mode !== "real") return err(400, "mode must be simulated or real");
  if (!isEngine(o.engine)) return err(400, `${o.engine}: ${UNSUPPORTED_ENGINE}; engine must be ${ENGINE_LIST}`);
  const engine: Engine = o.engine;
  const prompt = o.prompt.trim();
  if (!prompt) return err(400, "prompt is required");
  if (prompt.length > 20000) return err(400, "prompt is too long");
  const repo = o.repo;
  if (repo) { const d = checkTeamRepo(db, user.tenantId, repo); if (d) return err(400, d); }
  const label = o.agent ?? engine;
  const hash = o.hash ?? createHash("sha256").update(`${engine}\n${prompt}`).digest("hex");
  const wfName = o.agent ? `agent:${o.agent}` : `engine:${engine}`;
  const workflow: Workflow = {
    name: wfName, version: "1", description: o.purpose ?? (o.agent ? `Direct run of team agent ${o.agent}` : `Direct ${engine} run`), system: false, template: false, engine,
    on: { manual: true }, governance: { owner: user.email, approvers: [{ role: "admin" }], reviewers: [], min_approvals: 1 }, inputs: {},
    steps: [{ id: "agent", name: label, uses: "agent", needs: [], with: { agent: label, mode, repo: repo ?? "" }, secrets: [], outputs: { summary: "${{ result.summary }}", branch: "${{ result.branch }}", pushed: "${{ result.pushed }}" }, retries: 0, continue_on_error: false }],
    outputs: { summary: "${{ steps.agent.outputs.summary }}", branch: "${{ steps.agent.outputs.branch }}", pushed: "${{ steps.agent.outputs.pushed }}" },
  };
  const loaded: LoadedWorkflow = { workflow, file: wfName, source: "", hash, origin: "tenant", agents: { [label]: { engine, model: o.model ?? null, prompt, hash } }, agentErrors: [] };
  // Cron runs have no user: created_by stays NULL and triggered_by records 'schedule'.
  const run = startWorkflowRun(db, o.scheduled ? { tenantId: user.tenantId, userId: null, triggeredBy: o.triggeredBy ?? "schedule" } : { tenantId: user.tenantId, userId: user.id }, loaded, {}, {
    handlers: deps.handlers, resolveSecret: deps.resolveSecret, redact: deps.redact(), preApproved: true, inputs: {},
    meta: { engine, prompt, promptSource: o.agent ? "agent" : "custom", mode, repo },
  });
  return { ...ok({ id: run.id, agent: o.agent ?? null, hash, engine, mode, repo: repo ?? null, prompt, startedAt: run.startedAt }, 201), run };
}
