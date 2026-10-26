// SOP skill plans: the authoritative, deterministic control flow of a skill, stored as JSON.
// No YAML. A plan is an ordered list of steps; each step has an action, literal `with`
// arguments, explicit handoffs (named values taken from inputs, run fields or earlier
// steps' outputs, used as {{name}} placeholders), a `when` condition over those same
// sources, and on_failure: stop | continue | { goto: <later step id> } (forward only, so
// there are no loops). The zod schema is the source of truth; planJsonSchema() exports it.
import { z } from "zod";
import { evaluate, operandPaths } from "../workflows/expr";

export const ACTIONS = ["agent", "github", "simulate", "shell", "approval", "call_skill"] as const;
export type Action = (typeof ACTIONS)[number];
export const GITHUB_ACTIONS = ["issue_create", "pr_from_issue", "merge", "create-issue", "create-pr", "merge-pr"] as const;
export const RUN_FIELDS = ["id", "repo", "mode", "engine", "prompt"] as const;
export const MAX_DEPTH = 4;
/** Generous technical limits (no product length caps): body 4 MB, plan JSON 4 MB, 2000 steps. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_PLAN_BYTES = 4 * 1024 * 1024;
export const MAX_STEPS = 2000;

const ID = /^[a-z][a-z0-9_-]{0,62}$/;
const id = (w: string) => z.string().regex(ID, `${w} must be lowercase letters, digits, '-' or '_' and start with a letter`);
const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const SOURCE = /^(inputs\.[a-z][a-z0-9_-]*|run\.[a-z_]+|steps\.[a-z][a-z0-9_-]*\.(outputs\.[A-Za-z0-9_-]+|status))$/;

export const PlanInputSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean"]).default("string"),
  required: z.boolean().default(false),
  default: Scalar.optional(),
  description: z.string().max(500).optional(),
});
export const HandoffSchema = z.strictObject({
  from: z.string().regex(SOURCE, "from must be inputs.<name>, run.<field>, steps.<id>.outputs.<name> or steps.<id>.status"),
  to: z.string().regex(/^[a-z][a-z0-9_]*$/, "to must be a lowercase variable name"),
});
export const OnFailureSchema = z.union([z.enum(["stop", "continue"]), z.strictObject({ goto: id("goto") })]);
export const PlanStepSchema = z.strictObject({
  id: id("step id"),
  name: z.string().max(500).optional(),
  action: z.enum(ACTIONS),
  skill: id("skill").optional().describe("call_skill: the team skill to run"),
  with: z.record(z.string(), Scalar).default({}),
  handoffs: z.array(HandoffSchema).default([]),
  section: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "section is a heading anchor of the SOP body").optional().describe("agent steps: the SOP body section (heading anchor) passed with the prompt"),
  when: z.string().max(2000).optional().describe("Condition over inputs.*, run.*, steps.<id>.outputs.* / .status; the step is skipped when false"),
  on_failure: OnFailureSchema.optional(),
  outputs: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.string().regex(/^result(\.[A-Za-z0-9_-]+)*$/, "outputs map to result.<key>")).default({}),
  secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "secret names are UPPER_SNAKE env-file keys, never values")).default([]),
  timeout_seconds: z.number().positive().max(24 * 3600).optional(),
  retries: z.number().int().min(0).max(5).default(0),
});
export const PlanSchema = z.strictObject({
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), PlanInputSchema).default({}),
  steps: z.array(PlanStepSchema).min(1).max(MAX_STEPS),
  outputs: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.string().regex(SOURCE, "outputs map to steps.<id>.outputs.<name>, inputs.* or run.*")).default({}),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const planJsonSchema = () => ({ title: "Cobra SOP skill plan", ...z.toJSONSchema(PlanSchema, { io: "input", unrepresentable: "any" }) });

export const placeholders = (v: unknown): string[] => typeof v === "string" ? [...v.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]) : [];

/** Checks references a schema can't: unique ids, forward-only goto, handoff sources exist earlier, placeholders are declared. */
export function semanticErrors(plan: Plan): string[] {
  const errs: string[] = [];
  const pos = new Map<string, number>();
  plan.steps.forEach((s, i) => { if (pos.has(s.id)) errs.push(`steps[${i}].id: duplicate step id '${s.id}'`); else pos.set(s.id, i); });
  const checkSource = (where: string, p: string, i: number) => {
    const [root, a, b, c] = p.split(".");
    if (root === "inputs") { if (!(a in plan.inputs)) errs.push(`${where}: unknown input '${a}'`); }
    else if (root === "run") { if (!(RUN_FIELDS as readonly string[]).includes(a)) errs.push(`${where}: run.${a} is not available (${RUN_FIELDS.map((f) => `run.${f}`).join(", ")})`); }
    else if (root === "steps") {
      const j = pos.get(a);
      if (j === undefined) errs.push(`${where}: unknown step '${a}'`);
      else if (j >= i) errs.push(`${where}: step '${a}' is not before this step (handoffs only flow forward)`);
      else if (b === "outputs" && !(c in plan.steps[j].outputs)) errs.push(`${where}: step '${a}' has no output '${c}'`);
    } else errs.push(`${where}: unknown reference '${p}'`);
  };
  plan.steps.forEach((s, i) => {
    const w = `steps[${i}]`;
    const vars = new Set(s.handoffs.map((h) => h.to));
    s.handoffs.forEach((h, k) => checkSource(`${w}.handoffs[${k}].from`, h.from, i));
    for (const [k, v] of Object.entries(s.with)) for (const p of placeholders(v)) if (!vars.has(p)) errs.push(`${w}.with.${k}: {{${p}}} is not declared by a handoff`);
    if (s.when) {
      try { for (const p of operandPaths(s.when)) checkSource(`${w}.when`, p, i); evaluate({}, s.when); }
      catch (e) { errs.push(`${w}.when: ${(e as Error).message}`); }
      if (/\$\{\{/.test(s.when)) errs.push(`${w}.when: write the condition without \${{ }}`);
    }
    if (s.on_failure && typeof s.on_failure === "object") {
      const j = pos.get(s.on_failure.goto);
      if (j === undefined) errs.push(`${w}.on_failure.goto: unknown step '${s.on_failure.goto}'`);
      else if (j <= i) errs.push(`${w}.on_failure.goto: must jump forward to a later step (no loops)`);
    }
    if (s.action === "call_skill" && !s.skill) errs.push(`${w}.skill: call_skill needs skill`);
    if (s.action !== "call_skill" && s.skill) errs.push(`${w}.skill: only valid with action call_skill`);
    if (s.action === "github" && !(GITHUB_ACTIONS as readonly string[]).includes(String(s.with.action))) errs.push(`${w}.with.action: must be one of ${GITHUB_ACTIONS.join(", ")}`);
    if (s.action === "shell" && typeof s.with.run !== "string") errs.push(`${w}.with.run: shell steps need a run command`);
  });
  for (const [k, p] of Object.entries(plan.outputs)) checkSource(`outputs.${k}`, p, plan.steps.length);
  for (const [k, inp] of Object.entries(plan.inputs)) if (inp.required && inp.default !== undefined) errs.push(`inputs.${k}: required inputs can't have a default`);
  return errs;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[] };
const fmt = (issues: z.core.$ZodIssue[]) => issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);

/** Strict validation of a plan (object or JSON text). */
export function validatePlan(raw: unknown): PlanResult {
  let v = raw;
  if (typeof raw === "string") { if (Buffer.byteLength(raw) > MAX_PLAN_BYTES) return { ok: false, errors: ["plan is larger than the 4 MB technical limit"] }; try { v = JSON.parse(raw); } catch (e) { return { ok: false, errors: [`JSON: ${(e as Error).message}`] }; } }
  const r = PlanSchema.safeParse(v);
  if (!r.success) return { ok: false, errors: fmt(r.error.issues) };
  const errs = semanticErrors(r.data);
  return errs.length ? { ok: false, errors: errs } : { ok: true, plan: r.data };
}

/** Canonical JSON (sorted keys) so the content hash doesn't depend on key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
