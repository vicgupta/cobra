// Native deterministic executor for SOP skills: walks plan.steps in order (no DAG, no freeform
// branching). Per step: `when` (expr.ts condition), declared handoffs bind {{var}} placeholders,
// retries, timeout, on_failure stop|continue|goto (forward only, so it always terminates).
// call_skill runs the child skill as its own run (own runs row and audit trail), depth-capped.
// Shares only low-level pieces with workflows: the step handlers, expr.ts, the runs and
// run_step_events tables and usage capture (the agent runner reports usage by run/step key).
// It never uses the YAML engine, runner or parser.
import type { DB } from "../db";
import { finalPrompt, getAgent } from "../agents";
import { condition, type Scope } from "../workflows/expr";
import { LOG_CAP, redact as redactText, type Handlers, type StepContext } from "../workflows/engine";
import type { WorkflowStep } from "../workflows/schema";
import { MAX_DEPTH, type Plan, type PlanStep } from "./plan";
import { sectionText } from "./sections";
import { approvalState, audit, effectiveHash, skillByName, SkillError, type Skill } from "./store";

export type SkillDeps = { handlers: Handlers; resolveSecret: (name: string) => string | undefined; redact: () => string[] };
export type Mode = "simulated" | "real";
export type StepResult = { status: "pending" | "running" | "succeeded" | "failed" | "skipped"; outputs: Record<string, unknown>; error?: string; attempts: number; startedAt?: number; endedAt?: number; childRun?: string };
export type SkillRunResult = { id: string; status: "succeeded" | "failed"; steps: Record<string, StepResult>; outputs: Record<string, unknown>; error?: string };
export type Who = { tenantId: number; userId: number | null; email: string };

const scalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const get = (o: unknown, path: string[]): unknown => path.reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);

/** Coerces and checks run inputs against plan.inputs. */
export function resolveInputs(plan: Plan, raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}, errs: string[] = [];
  for (const [k, d] of Object.entries(plan.inputs)) {
    let v = raw[k];
    if (v === undefined || v === "") v = d.default;
    if (v === undefined) { if (d.required) errs.push(`input '${k}' is required`); continue; }
    if (d.type === "number") { const n = Number(v); if (!Number.isFinite(n)) errs.push(`input '${k}' must be a number`); else out[k] = n; }
    else if (d.type === "boolean") out[k] = v === true || v === "true";
    else if (scalar(v)) out[k] = String(v); else errs.push(`input '${k}' must be a string`);
  }
  if (errs.length) throw new SkillError(400, errs);
  return out;
}

/** Fills {{var}} placeholders from the step's bound variables (unbound → ""). */
const fill = (v: unknown, vars: Record<string, unknown>) => typeof v === "string"
  ? v.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, n) => { const x = vars[n]; return x === undefined || x === null ? "" : typeof x === "string" ? x : JSON.stringify(x); })
  : v;

export type ExecOptions = { mode?: Mode; repo?: string; now?: number; depth?: number; parent?: string; path?: string[]; idPrefix?: string };

/**
 * Starts a skill run. Real-mode runs need the effective hash approved; simulated runs are dry runs
 * (agents and GitHub simulated, shell and approval steps not executed) and need no approval.
 */
export function startSkillRun(db: DB, who: Who, skill: Skill, rawInputs: Record<string, unknown>, deps: SkillDeps, o: ExecOptions = {}): { id: string; done: Promise<SkillRunResult> } {
  const mode: Mode = o.mode === "real" ? "real" : "simulated";
  const depth = o.depth ?? 0;
  const path = o.path ?? [skill.name];
  if (depth > MAX_DEPTH) throw new SkillError(400, [`composition deeper than ${MAX_DEPTH} levels`]);
  const eff = effectiveHash(db, skill);
  if (eff.errors.length) throw new SkillError(400, eff.errors);
  if (mode === "real" && depth === 0 && approvalState(db, skill).status !== "approved") throw new SkillError(409, [`skill '${skill.name}' @${eff.hash.slice(0, 12)} isn't approved for real runs (simulated runs are allowed)`]);
  const inputs = resolveInputs(skill.plan, rawInputs);
  const startedAt = o.now ?? Date.now();
  const id = `${o.idPrefix ?? "skr_"}${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const run = { id, repo: o.repo ?? "", mode, engine: "", prompt: String(inputs.prompt ?? "") };
  const agentSteps = skill.plan.steps.filter((s) => s.action === "agent").length;
  db.prepare(`INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at, workflow, workflow_hash, status, engine, prompt_source, mode, branch, triggered_by)
    VALUES (?, ?, ?, '', ?, 0, ?, ?, ?, ?, ?, ?, 'running', NULL, 'skill', ?, ?, ?)`).run(
    id, who.tenantId, who.userId, run.repo, o.parent ? `${skill.name} (called by ${o.parent})` : skill.name, run.prompt.slice(0, 20000), mode === "simulated" ? 1 : 0,
    startedAt, `skill:${skill.name}`, eff.hash, mode, mode === "real" && agentSteps === 1 ? `cobra/${id}` : null, who.email);
  audit(db, { id: who.userId ?? 0, email: who.email, tenantId: who.tenantId }, "skill_run", skill.id, `${id} ${mode}${o.parent ? ` (from ${o.parent})` : ""} @${eff.hash.slice(0, 12)}`, skill.tenantId);
  const done = execute(db, who, skill, inputs, run, deps, { depth, path, agentSteps }).catch((e: unknown) => {
    const error = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE runs SET status = 'failed', error = ?, ended_at = ? WHERE id = ?").run(redactText(error, deps.redact()), Date.now(), id);
    return { id, status: "failed" as const, steps: {}, outputs: {}, error };
  });
  return { id, done };
}

async function execute(db: DB, who: Who, skill: Skill, inputs: Record<string, unknown>, run: { id: string; repo: string; mode: Mode; engine: string; prompt: string }, deps: SkillDeps, x: { depth: number; path: string[]; agentSteps: number }): Promise<SkillRunResult> {
  const { plan } = skill;
  const secretsList = deps.redact();
  const logEvent = db.prepare("INSERT INTO run_step_events (run_id, tenant_id, step_id, status, attempt, output, truncated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const update = db.prepare("UPDATE runs SET status = ?, steps_json = ?, outputs_json = ?, error = ?, ended_at = ? WHERE id = ?");
  const steps: Record<string, StepResult> = {};
  const now = Date.now();
  logEvent.run(run.id, who.tenantId, "run", "succeeded", 0, redactText(`skill: ${skill.name} v${skill.version}\nmode: ${run.mode}\nrepo: ${run.repo || "(none)"}\ninputs: ${JSON.stringify(inputs).slice(0, 4000)}`, secretsList), 0, now);
  for (const s of plan.steps) { steps[s.id] = { status: "pending", outputs: {}, attempts: 0 }; logEvent.run(run.id, who.tenantId, s.id, "pending", 0, null, 0, now); }
  const index = new Map(plan.steps.map((s, i) => [s.id, i]));
  const scope: Scope = { inputs, run, steps: {} as Record<string, unknown> };
  const stepScope = scope.steps as Record<string, { outputs: Record<string, unknown>; status: string }>;
  const save = (status: string, error: string | null, outputs: Record<string, unknown> | null, ended: boolean) =>
    update.run(status, JSON.stringify(steps), outputs ? JSON.stringify(outputs) : null, error, ended ? Date.now() : null, run.id);
  let failed: string | undefined;
  let i = 0;
  while (i < plan.steps.length) {
    const step = plan.steps[i];
    const st = steps[step.id];
    if (step.when && !condition(scope, step.when)) {
      st.status = "skipped"; stepScope[step.id] = { outputs: {}, status: "skipped" };
      logEvent.run(run.id, who.tenantId, step.id, "skipped", 0, `condition false: ${step.when}`, 0, Date.now());
      i++; continue;
    }
    const vars: Record<string, unknown> = {};
    for (const h of step.handoffs) vars[h.to] = get(scope, h.from.split("."));
    st.status = "running"; st.startedAt = Date.now();
    let lastErr = "";
    let result: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= step.retries + 1; attempt++) {
      st.attempts = attempt;
      logEvent.run(run.id, who.tenantId, step.id, "running", attempt, null, 0, Date.now());
      save("running", null, null, false);
      let log = "";
      try {
        result = await runStep(db, who, skill, step, vars, run, deps, x, (c) => { log = (log + c).slice(-LOG_CAP); }, st);
        logEvent.run(run.id, who.tenantId, step.id, "succeeded", attempt, redactText(log + JSON.stringify(result).slice(0, LOG_CAP), secretsList).slice(0, LOG_CAP), 0, Date.now());
        break;
      } catch (e) {
        lastErr = redactText(e instanceof Error ? e.message : String(e), secretsList);
        logEvent.run(run.id, who.tenantId, step.id, "failed", attempt, (log ? redactText(log, secretsList) + "\n" : "") + lastErr, 0, Date.now());
      }
    }
    st.endedAt = Date.now();
    if (result) {
      st.status = "succeeded";
      for (const [k, src] of Object.entries(step.outputs)) st.outputs[k] = get(result, src.split(".").slice(1));
      stepScope[step.id] = { outputs: st.outputs, status: "succeeded" };
      i++; continue;
    }
    st.status = "failed"; st.error = lastErr;
    stepScope[step.id] = { outputs: {}, status: "failed" };
    const of = step.on_failure ?? "stop";
    if (of === "continue") { i++; continue; }
    if (typeof of === "object") { i = index.get(of.goto)!; continue; }
    failed = `step '${step.id}' failed: ${lastErr}`; break;
  }
  const outputs: Record<string, unknown> = {};
  for (const [k, src] of Object.entries(plan.outputs)) outputs[k] = get(scope, src.split("."));
  // Steps never reached after a stop stay "pending".
  const status = failed ? "failed" : "succeeded";
  save(status, failed ?? null, outputs, true);
  return { id: run.id, status, steps, outputs, error: failed };
}

async function runStep(db: DB, who: Who, skill: Skill, step: PlanStep, vars: Record<string, unknown>, run: { id: string; repo: string; mode: Mode }, deps: SkillDeps, x: { depth: number; path: string[]; agentSteps: number }, log: (c: string) => void, st: StepResult): Promise<Record<string, unknown>> {
  const w: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.with)) w[k] = fill(v, vars);
  const sim = run.mode === "simulated";
  if (step.action === "call_skill") {
    const child = skillByName(db, skill.tenantId, step.skill!);
    if (!child) throw new Error(`unknown skill '${step.skill}'`);
    if (x.path.includes(child.name)) throw new Error(`skill composition cycle: ${[...x.path, child.name].join(" -> ")}`);
    if (x.depth + 1 > MAX_DEPTH) throw new Error(`composition deeper than ${MAX_DEPTH} levels`);
    const r = startSkillRun(db, who, child, w, deps, { mode: run.mode, repo: typeof w.repo === "string" && w.repo ? w.repo : run.repo, depth: x.depth + 1, parent: `${skill.name}/${run.id}`, path: [...x.path, child.name] });
    st.childRun = r.id;
    log(`[call_skill] ${child.name} → run ${r.id}\n`);
    const res = await r.done;
    if (res.status !== "succeeded") throw new Error(`skill '${child.name}' (run ${r.id}) failed: ${res.error ?? "failed"}`);
    return { ...res.outputs, run_id: r.id, status: res.status };
  }
  if (step.action === "shell") {
    if (sim) return { simulated: true, would_run: String(w.run ?? "") };
  }
  if (step.action === "approval" && sim) return { simulated: true, approved: true };
  if (step.action === "agent") {
    if (w.mode === undefined || w.mode === "") w.mode = run.mode;
    if (sim) w.mode = "simulated";
    if (w.repo === undefined || w.repo === "") w.repo = run.repo;
    let prompt = String(w.prompt ?? "");
    if (typeof w.agent === "string" && w.agent) {
      const a = getAgent(db, skill.tenantId, w.agent);
      if (!a) throw new Error(`unknown agent '${w.agent}'`);
      w.driver = a.engine; if (a.model) w.model = a.model;
      prompt = finalPrompt(a.prompt, prompt);
    }
    if (step.section) {
      const sec = sectionText(skill.body, step.section);
      if (sec === null) throw new Error(`SOP section '${step.section}' not found`);
      prompt += `\n\n--- SOP section #${step.section} ---\n${sec}`;
    }
    if (skill.body.trim()) { prompt += "\n\n(The full SOP is in .cobra/SOP.md in your workspace.)"; w.sop_body = skill.body; }
    w.prompt = prompt;
    log(`[agent] ${String(w.agent ?? w.driver ?? "claude-code")} (${String(w.mode)})${step.section ? ` section #${step.section}` : ""}\n`);
  }
  if (step.action === "github" && sim) w.mode = "simulated";
  const handler = deps.handlers[step.action as WorkflowStep["uses"]];
  if (!handler) throw new Error(`no handler for '${step.action}' on this server`);
  const secrets: Record<string, string> = {};
  for (const n of step.secrets) { const v = deps.resolveSecret(n); if (v === undefined) throw new Error(`secret ${n} isn't set on the server`); secrets[n] = v; }
  const ac = new AbortController();
  const timeoutMs = step.timeout_seconds ? step.timeout_seconds * 1000 : undefined;
  const t = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
  const wfStep = { id: step.id, uses: step.action, with: step.with } as unknown as WorkflowStep;
  const ctx: StepContext = { runId: run.id, stepKey: x.agentSteps > 1 ? `${run.id}-${step.id}` : run.id, step: wfStep, with: w, run: step.action === "shell" ? String(w.run ?? "") : undefined, secrets, signal: ac.signal, timeoutMs, log };
  try { return await handler(ctx); } finally { if (t) clearTimeout(t); }
}
