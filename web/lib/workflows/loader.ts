// Discovers, parses and validates workflow files. Directory: COBRA_WORKFLOWS_DIR,
// else <repo>/workflows (the web app runs with cwd = web/, so ../workflows).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { refsIn, operandPaths } from "./expr";
import { formatIssues, WorkflowSchema, type Workflow } from "./schema";

/** repo: workflows/*.yaml (built-ins); template: workflows/templates/*.yaml (system templates); tenant: a tenant's own copy stored in the DB. */
export type Origin = "repo" | "template" | "tenant";
export type LoadedWorkflow = {
  workflow: Workflow; file: string; source: string; hash: string; origin: Origin;
  /** Email of whoever saved this content (tenant workflows); counts as an author for self-approval. */
  author?: string;
  /** Hash of the YAML alone when `hash` is the effective hash including referenced team agents. */
  sourceHash?: string;
  /** Team agents referenced by `with: { agent }` steps, resolved for the workflow's tenant. */
  agents?: Record<string, ResolvedAgent>;
  /** Unknown agent references (run-time validation errors shown on the workflow page). */
  agentErrors?: string[];
};
export type ResolvedAgent = { engine: "claude-code" | "codex"; prompt: string; hash: string };
export type LoadError = { file: string; errors: string[] };
export class WorkflowError extends Error {
  constructor(public file: string, public errors: string[]) {
    super(`${file}:\n  - ${errors.join("\n  - ")}`);
  }
}

export function workflowsDir(): string {
  if (process.env.COBRA_WORKFLOWS_DIR) return process.env.COBRA_WORKFLOWS_DIR;
  const fromWeb = path.resolve(process.cwd(), "..", "workflows");
  return existsSync(fromWeb) ? fromWeb : path.resolve(process.cwd(), "workflows");
}

/** sha256 of the exact file bytes (line endings normalised): approval is tied to this. */
export const contentHash = (source: string) => createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");

/** Topological order of steps; throws listing the cycle. */
export function topoOrder(wf: Pick<Workflow, "steps">): string[] {
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  const order: string[] = [], state = new Map<string, 1 | 2>();
  const visit = (id: string, stack: string[]) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(" -> ")}`);
    state.set(id, 1);
    for (const n of byId.get(id)!.needs) visit(n, [...stack, id]);
    state.set(id, 2);
    order.push(id);
  };
  for (const s of wf.steps) visit(s.id, []);
  return order;
}

/** Ancestors of a step via needs (a step may only read outputs of these). */
function ancestors(wf: Workflow, id: string, acc = new Set<string>()): Set<string> {
  for (const n of wf.steps.find((s) => s.id === id)?.needs ?? []) if (!acc.has(n)) { acc.add(n); ancestors(wf, n, acc); }
  return acc;
}

/** Run-level values steps can read: ${{ run.engine }}, ${{ run.prompt }}, ... */
export const RUN_FIELDS = ["id", "engine", "prompt", "prompt_source", "repo", "mode", "branch"];

/** Graph and reference checks the schema can't express. */
export function semanticErrors(wf: Workflow): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  wf.steps.forEach((s, i) => { if (ids.has(s.id)) errors.push(`steps[${i}].id: duplicate step id '${s.id}'`); ids.add(s.id); });
  wf.steps.forEach((s, i) => s.needs.forEach((n) => { if (!ids.has(n)) errors.push(`steps[${i}].needs: unknown step '${n}'`); if (n === s.id) errors.push(`steps[${i}].needs: step needs itself`); }));
  if (errors.length) return errors;
  try { topoOrder(wf); } catch (e) { return [(e as Error).message]; }
  for (const [name, inp] of Object.entries(wf.inputs)) {
    if (inp.type === "choice" && !inp.options) errors.push(`inputs.${name}.options: required for type choice`);
    if (inp.required && inp.default !== undefined) errors.push(`inputs.${name}: required inputs cannot have a default`);
  }
  const check = (where: string, paths: string[], allowedSteps: Set<string> | "all", allowResult: boolean) => {
    for (const p of paths) {
      const [root, a, b] = p.split(".");
      if (root === "inputs") { if (!a || !(a in wf.inputs)) errors.push(`${where}: unknown input '${a ?? ""}'`); }
      else if (root === "steps") {
        if (!a || !ids.has(a)) errors.push(`${where}: unknown step '${a ?? ""}'`);
        else if (allowedSteps !== "all" && !allowedSteps.has(a)) errors.push(`${where}: step '${a}' is not in needs (directly or transitively)`);
        else if (b !== "outputs" && b !== "status") errors.push(`${where}: use steps.${a}.outputs.<name> or steps.${a}.status`);
        else if (b === "outputs") { const key = p.split(".")[3]; const st = wf.steps.find((s) => s.id === a)!; if (!key || !(key in st.outputs)) errors.push(`${where}: step '${a}' has no output '${key ?? ""}'`); }
      } else if (root === "result" && allowResult) { /* the step's own result */ }
      else if (root === "run") { if (!RUN_FIELDS.includes(a ?? "")) errors.push(`${where}: run.${a ?? ""} is not available (use ${RUN_FIELDS.map((f) => `run.${f}`).join(", ")})`); }
      else errors.push(`${where}: unknown reference '${p}' (use inputs.*, steps.*, run.id)`);
    }
  };
  wf.steps.forEach((s, i) => {
    const anc = ancestors(wf, s.id);
    for (const [k, v] of Object.entries(s.with)) if (typeof v === "string") check(`steps[${i}].with.${k}`, refsIn(v), anc, false);
    if (s.run) check(`steps[${i}].run`, refsIn(s.run), anc, false);
    if (s.if) check(`steps[${i}].if`, /\$\{\{/.test(s.if) ? refsIn(s.if) : operandPaths(s.if), anc, false);
    for (const [k, v] of Object.entries(s.outputs)) check(`steps[${i}].outputs.${k}`, refsIn(v), anc, true);
  });
  if (wf.prompt) check("prompt", refsIn(wf.prompt), new Set(), false);
  for (const [k, v] of Object.entries(wf.outputs)) check(`outputs.${k}`, refsIn(v), "all", false);
  return errors;
}

export function parseWorkflow(source: string, file = "<inline>", origin: Origin = "repo"): LoadedWorkflow {
  let raw: unknown;
  try { raw = parseYaml(source); } catch (e) {
    throw new WorkflowError(file, [e instanceof YAMLParseError ? `YAML: ${e.message}` : String(e)]);
  }
  const r = WorkflowSchema.safeParse(raw);
  if (!r.success) throw new WorkflowError(file, formatIssues(r.error.issues));
  const errs = semanticErrors(r.data);
  if (errs.length) throw new WorkflowError(file, errs);
  const flagErr = origin === "template"
    ? (!r.data.system || !r.data.template ? ["system templates must set system: true and template: true"] : [])
    : origin === "tenant"
      ? (r.data.system ? ["system: true is reserved for templates shipped with Cobra"] : [])
      : (r.data.template ? ["template: true files belong in workflows/templates/"] : []);
  if (flagErr.length) throw new WorkflowError(file, flagErr);
  const base = path.basename(file).replace(/\.ya?ml$/, "");
  if (origin !== "tenant" && file !== "<inline>" && base !== r.data.name) throw new WorkflowError(file, [`name: '${r.data.name}' must match the file name '${base}'`]);
  return { workflow: r.data, file, source, hash: contentHash(source), origin };
}

/** Loads every *.yaml / *.yml in the directory; invalid files are reported, not thrown. */
export const templatesDir = (dir = workflowsDir()) => path.join(dir, "templates");
export const loadTemplates = (dir = templatesDir()) => loadWorkflows(dir, "template");

export function loadWorkflows(dir = workflowsDir(), origin: Origin = "repo"): { workflows: LoadedWorkflow[]; errors: LoadError[] } {
  const workflows: LoadedWorkflow[] = [], errors: LoadError[] = [];
  if (!existsSync(dir)) return { workflows, errors: [{ file: dir, errors: ["workflows directory not found"] }] };
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const file = path.join(dir, f);
    try { workflows.push(parseWorkflow(readFileSync(file, "utf8"), file, origin)); }
    catch (e) { errors.push(e instanceof WorkflowError ? { file, errors: e.errors } : { file, errors: [String(e)] }); }
  }
  return { workflows, errors };
}

export function getWorkflow(name: string, dir = workflowsDir()): LoadedWorkflow {
  const { workflows, errors } = loadWorkflows(dir);
  const wf = workflows.find((w) => w.workflow.name === name);
  if (wf) return wf;
  const bad = errors.find((e) => path.basename(e.file).replace(/\.ya?ml$/, "") === name);
  if (bad) throw new WorkflowError(bad.file, bad.errors);
  throw new Error(`Workflow '${name}' not found in ${dir}`);
}
