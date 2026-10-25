// Executes a validated workflow: steps in topological order, ${{ }} passing of
// inputs/outputs, if-conditions, retries, timeouts, and status events for the
// caller to record (see lib/workflows/runner.ts for the runs-table recorder).
// The engine refuses to run a definition whose content hash isn't approved.
import { condition, interpolate, type Scope } from "./expr";
import { topoOrder, type LoadedWorkflow, type ResolvedAgent } from "./loader";
import { finalPrompt } from "../agents";
import type { Workflow, WorkflowStep } from "./schema";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type StepState = { status: StepStatus; skippedBy?: "condition" | "dependency"; log?: string; truncated?: boolean; outputs: Record<string, unknown>; error?: string; attempts: number; startedAt?: number; endedAt?: number };
export type RunStatus = "running" | "succeeded" | "failed";
export type RunResult = { status: RunStatus; steps: Record<string, StepState>; outputs: Record<string, unknown>; error?: string };

export type StepContext = {
  runId: string;
  /** Workspace/branch key: the run id, or <run-id>-<step-id> when the workflow has several agent steps. */
  stepKey?: string;
  step: WorkflowStep;
  with: Record<string, unknown>;
  run?: string;
  /** Values of step.secrets, read at run time via the env-file helpers. Never log. */
  secrets: Record<string, string>;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Streams a chunk of live output into the step log (redacted by the recorder). */
  log?: (chunk: string) => void;
};
export type StepHandler = (ctx: StepContext) => Promise<Record<string, unknown>>;
export type Handlers = Partial<Record<WorkflowStep["uses"], StepHandler>>;

export type EngineEvent =
  | { type: "run"; status: RunStatus; steps: Record<string, StepState>; outputs?: Record<string, unknown>; error?: string }
  | { type: "step"; id: string; state: StepState }
  | { type: "log"; id: string; chunk: string };

export class WorkflowNotApprovedError extends Error {
  constructor(name: string, hash: string) {
    super(`Workflow '${name}' (sha256 ${hash.slice(0, 12)}) is not approved; an allowed approver must approve this exact version first`);
  }
}
export class InputError extends Error {
  constructor(public errors: string[]) { super(errors.join("; ")); }
}

export type ExecuteOptions = {
  runId: string;
  inputs?: Record<string, unknown>;
  handlers: Handlers;
  /** Required: returns true only when this exact name+hash is approved. */
  isApproved: (name: string, hash: string) => boolean;
  resolveSecret?: (name: string) => string | undefined;
  onEvent?: (e: EngineEvent) => void;
  /** Extra values to redact from step logs (the runner passes every env-file value). */
  redact?: string[];
  /** Extra run-level values (engine, prompt, repo, mode, branch) visible as ${{ run.* }}. */
  run?: Record<string, unknown>;
  /** Team agents for `with: { agent }` steps (see withAgents); a missing one fails that step. */
  agents?: Record<string, ResolvedAgent>;
};

export const LOG_CAP = 16_000;

/** Removes secret values (and their JSON-escaped forms) from text. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const v of [...new Set(secrets)].filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1)])) out = out.split(form).join("[REDACTED]");
  }
  return out;
}

/** Step output for the log: stdout/stderr, agent summary/log, else the JSON result; capped. */
export function stepLog(result: Record<string, unknown> | undefined, error: string | undefined, secrets: Iterable<string>): { log: string; truncated: boolean } {
  const parts: string[] = [];
  if (result) {
    for (const k of ["stdout", "stderr", "log", "summary"]) if (typeof result[k] === "string" && result[k]) parts.push(`[${k}]\n${result[k] as string}`);
    if (!parts.length) parts.push(JSON.stringify(result));
  }
  if (error) parts.push(`[error]\n${error}`);
  const text = redact(parts.join("\n"), secrets);
  return text.length > LOG_CAP ? { log: text.slice(0, LOG_CAP) + `\n… [truncated ${text.length - LOG_CAP} chars]`, truncated: true } : { log: text, truncated: false };
}

/** Applies defaults, coerces types and enforces required/options/pattern. */
export function resolveInputs(wf: Workflow, raw: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}, errors: string[] = [];
  for (const k of Object.keys(raw)) if (!(k in wf.inputs)) errors.push(`unknown input '${k}'`);
  for (const [k, def] of Object.entries(wf.inputs)) {
    let v = raw[k];
    if (v === undefined || v === null || v === "") {
      if (def.default !== undefined) v = def.default;
      else if (def.required) { errors.push(`${k} is required`); continue; }
      else continue;
    }
    if (def.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`${k} must be a number`); continue; }
      if (def.min !== undefined && n < def.min) { errors.push(`${k} must be >= ${def.min}`); continue; }
      out[k] = n;
    } else if (def.type === "boolean") {
      if (v === true || v === "true") out[k] = true;
      else if (v === false || v === "false") out[k] = false;
      else errors.push(`${k} must be true or false`);
    } else {
      let s = String(v);
      if (def.max_length) s = s.slice(0, def.max_length);
      if (def.type === "choice" && !def.options!.includes(s)) { errors.push(`${k} must be one of ${def.options!.join(", ")}`); continue; }
      if (def.pattern && !new RegExp(def.pattern).test(s)) { errors.push(`${k} must match ${def.pattern}`); continue; }
      out[k] = s;
    }
  }
  if (errors.length) throw new InputError(errors);
  return out;
}

const withHeader = (h: string, l: { log: string; truncated: boolean }) => (h ? { ...l, log: h + l.log } : l);

function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms?: number): Promise<T> {
  const ac = new AbortController();
  if (!ms) return fn(ac.signal);
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    fn(ac.signal),
    new Promise<T>((_, rej) => { t = setTimeout(() => { ac.abort(); rej(new Error(`timed out after ${ms / 1000}s`)); }, ms); }),
  ]).finally(() => clearTimeout(t));
}

export async function executeWorkflow(loaded: LoadedWorkflow, opts: ExecuteOptions): Promise<RunResult> {
  const { workflow: wf, hash } = loaded;
  if (!opts.isApproved(wf.name, hash)) throw new WorkflowNotApprovedError(wf.name, hash);
  const inputs = resolveInputs(wf, opts.inputs);
  const steps: Record<string, StepState> = Object.fromEntries(wf.steps.map((s) => [s.id, { status: "pending", outputs: {}, attempts: 0 } as StepState]));
  const scope: Scope = { inputs, steps, run: { ...opts.run, id: opts.runId } };
  const emit = opts.onEvent ?? (() => {});
  const secretValues = new Set(opts.redact ?? []);
  const setStep = (id: string, patch: Partial<StepState>) => { steps[id] = { ...steps[id], ...patch }; emit({ type: "step", id, state: steps[id] }); };
  emit({ type: "run", status: "running", steps });
  // Steps run one at a time in topological order (independent steps are not parallel).
  const agentSteps = wf.steps.filter((s) => s.uses === "agent").length;

  for (const id of topoOrder(wf)) {
    const step = wf.steps.find((s) => s.id === id)!;
    // A need that failed, or was skipped because its own needs failed, blocks this step.
    // A need skipped by its own if-condition does not (optional stages, e.g. a spec step).
    if (step.needs.some((n) => steps[n].status === "failed" || steps[n].skippedBy === "dependency" || steps[n].status === "pending")) { setStep(id, { status: "skipped", skippedBy: "dependency" }); continue; }
    try {
      if (step.if && !condition(scope, step.if)) { setStep(id, { status: "skipped", skippedBy: "condition" }); continue; }
    } catch (e) { setStep(id, { status: "failed", error: `if: ${(e as Error).message}` }); continue; }
    const handler = opts.handlers[step.uses];
    setStep(id, { status: "running", startedAt: Date.now() });
    let lastError = "", header = "";
    for (let attempt = 1; attempt <= step.retries + 1; attempt++) {
      try {
        if (!handler) throw new Error(`no handler registered for uses: ${step.uses}`);
        const secrets: Record<string, string> = {};
        for (const name of step.secrets) {
          const v = opts.resolveSecret?.(name);
          if (!v) throw new Error(`secret ${name} is not set (add it in Settings / the server env file)`);
          secrets[name] = v;
          secretValues.add(v);
        }
        const withArgs: Record<string, unknown> = Object.fromEntries(Object.entries(step.with).map(([k, v]) => [k, interpolate(scope, v)]));
        if (step.uses === "agent" && typeof step.with.agent === "string") {
          // Team agent: fixed engine; its prompt (literal) plus the step's interpolated with.prompt as extra instructions.
          const name = step.with.agent, a = opts.agents?.[name];
          if (!a) throw new Error(`unknown agent '${name}' (not defined for this team)`);
          const run = (scope.run ?? {}) as Record<string, unknown>;
          withArgs.driver = a.engine;
          withArgs.prompt = finalPrompt(a.prompt, withArgs.prompt);
          if (withArgs.mode === undefined || withArgs.mode === "") withArgs.mode = run.mode || "simulated";
          if (withArgs.repo === undefined || withArgs.repo === "") withArgs.repo = run.repo || "";
          if (!header) {
            header = redact(`[agent] ${name} @ ${a.hash.slice(0, 12)} (${a.engine}, ${String(withArgs.mode)})\n[prompt]\n${String(withArgs.prompt)}\n`, secretValues);
            emit({ type: "log", id, chunk: header });
          }
        }
        const run = step.run === undefined ? undefined : String(interpolate(scope, step.run));
        const timeoutMs = step.timeout_seconds ? step.timeout_seconds * 1000 : undefined;
        const result = await withTimeout((signal) => handler({ runId: opts.runId, stepKey: agentSteps > 1 ? `${opts.runId}-${id}` : opts.runId, step, with: withArgs, run, secrets, signal, timeoutMs, log: (chunk) => emit({ type: "log", id, chunk: redact(chunk, secretValues) }) }), timeoutMs);
        const outScope = { ...scope, result };
        const outputs = Object.fromEntries(Object.entries(step.outputs).map(([k, v]) => [k, interpolate(outScope, v)]));
        setStep(id, { status: "succeeded", outputs, attempts: attempt, endedAt: Date.now(), error: undefined, ...withHeader(header, stepLog(result, undefined, secretValues)) });
        lastError = "";
        break;
      } catch (e) {
        lastError = redact(e instanceof Error ? e.message : String(e), secretValues);
        steps[id] = { ...steps[id], attempts: attempt };
      }
    }
    if (lastError) {
      // continue_on_error: dependents still run (the step counts as succeeded, its error is kept).
      setStep(id, { status: step.continue_on_error ? "succeeded" : "failed", error: lastError, endedAt: Date.now(), ...withHeader(header, stepLog(undefined, lastError, secretValues)) });
    }
  }
  const failed = Object.entries(steps).filter(([, s]) => s.status === "failed").map(([k]) => k);
  const outputs = Object.fromEntries(Object.entries(wf.outputs).map(([k, v]) => [k, interpolate(scope, v)]));
  const result: RunResult = failed.length
    ? { status: "failed", steps, outputs, error: `step(s) failed: ${failed.join(", ")}` }
    : { status: "succeeded", steps, outputs };
  emit({ type: "run", status: result.status, steps, outputs, error: result.error });
  return result;
}
