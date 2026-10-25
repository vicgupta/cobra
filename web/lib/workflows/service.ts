// Route logic for the workflow API, kept free of Next so tests can exercise the
// permission checks directly. Each function returns { status, body }.
import type { DB } from "../db";
import { approvalState, canApprove, PermissionError, recordDecision, selfApprovalPolicy } from "./approvals";
import { InputError, WorkflowNotApprovedError, type Handlers } from "./engine";
import type { LoadedWorkflow } from "./loader";
import { canViewRun, getRunDetail, listWorkflowRuns, startWorkflowRun } from "./runner";
import { canEdit, canRun, findWorkflow, freeName, instancesOf, listAll, saveTenantWorkflow, SaveError, storageOf, syncFromGitHub, systemTemplates, templateCopySource, type Actor, type Storage } from "./store";
import type { GitHubFiles } from "./github-files";

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
    triggers: Object.keys(wf.on).filter((k) => (wf.on as Record<string, unknown>)[k]),
  };
}

export function listWorkflowsFor(db: DB, user: Actor, dir?: string): Res {
  return ok(listAll(db, user.tenantId, dir).map((l) => (l.loaded ? summary(db, user, l.loaded) : { name: l.name, origin: l.origin, errors: l.errors })));
}

export function workflowDetail(db: DB, user: Actor, name: string, dir?: string): Res {
  const w = findWorkflow(db, user.tenantId, name, dir);
  if (!w) return err(404, `workflow '${name}' not found`);
  const st = approvalState(db, user.tenantId, w);
  return ok({
    ...summary(db, user, w),
    source: w.source,
    inputs: w.workflow.inputs,
    steps: w.workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, uses: s.uses, needs: s.needs, if: s.if ?? null, secrets: s.secrets })),
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
    createdFrom: w.origin === "tenant" ? (db.prepare("SELECT template_name AS name, template_hash AS hash FROM tenant_workflows WHERE tenant_id = ? AND name = ?").get(user.tenantId, name) as { name: string | null; hash: string | null }) : null,
  });
}

type SaveBody = { source?: unknown; previousName?: unknown; templateName?: unknown; storage?: unknown; github?: { repo?: unknown; path?: unknown; branch?: unknown } | null; import?: unknown };
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
      previousName: str(body.previousName), templateName: str(body.templateName), storage, github: deps.github, importExisting: imp, dir: deps.dir,
    });
    return ok(summary(db, user, w), body.previousName ? 200 : 201);
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

export function startRun(db: DB, user: Actor, name: string, body: { inputs?: unknown } | null, deps: RunDeps, extra: { idPrefix?: string } = {}): Res & { run?: ReturnType<typeof startWorkflowRun> } {
  const w = findWorkflow(db, user.tenantId, name, deps.dir);
  if (!w) return err(404, `workflow '${name}' not found`);
  if (!canRun(user, w)) return err(403, w.workflow.template ? "templates can't be run; copy one into a workflow first" : "you can't run this workflow");
  const inputs = body?.inputs && typeof body.inputs === "object" ? (body.inputs as Record<string, unknown>) : {};
  try {
    const run = startWorkflowRun(db, { tenantId: user.tenantId, userId: user.id }, w, inputs, { handlers: deps.handlers, resolveSecret: deps.resolveSecret, redact: deps.redact(), idPrefix: extra.idPrefix });
    return { ...ok({ id: run.id, startedAt: run.startedAt, inputs: run.inputs, workflow: name }, 201), run };
  } catch (e) {
    if (e instanceof WorkflowNotApprovedError) return err(409, e.message);
    if (e instanceof InputError) return err(400, e.errors[0], e.errors);
    throw e;
  }
}

export function runDetailFor(db: DB, user: Actor, id: string): Res {
  const r = getRunDetail(db, id);
  // 404 (not 403) for other users' runs so ids can't be probed.
  if (!r || !canViewRun(user, r)) return err(404, "run not found");
  return ok(r);
}
