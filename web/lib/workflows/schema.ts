// Workflow file format (workflows/*.yaml at the repo root). A GitHub-Actions-like
// shape: on/inputs/steps/needs/if/with/outputs, plus a governance block.
// The zod schema is the source of truth; workflows/workflow.schema.json is
// generated from it (npm run workflow:schema) and checked by a test.
import { z } from "zod";

export const ROLES = ["admin", "team_lead", "member"] as const;
export type Role = (typeof ROLES)[number];

const ID = /^[a-z][a-z0-9_-]*$/;
const id = (what: string) => z.string().regex(ID, `${what} must be lowercase letters, digits, '-' or '_' and start with a letter`);
const email = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address").transform((s) => s.toLowerCase());
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export const InputSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "choice"]).default("string"),
  description: z.string().optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).min(1).optional().describe("Allowed values when type is choice"),
  pattern: z.string().optional().describe("Regex a string input must match"),
  min: z.number().optional(),
  max_length: z.number().int().positive().optional(),
});

const Approver = z.union([email, z.strictObject({ role: z.enum(ROLES) })]);

export const GovernanceSchema = z.strictObject({
  owner: email.describe("Author/owner of the workflow; counts as the author of any change"),
  approvers: z.array(Approver).min(1).describe("Emails and/or { role: admin|team_lead|member } allowed to approve"),
  reviewers: z.array(email).default([]).describe("Informational: notified/asked to review, cannot approve unless also an approver"),
  min_approvals: z.number().int().min(1).default(1),
});

export const TriggerSchema = z.strictObject({
  manual: z.union([z.literal(true), z.strictObject({})]).optional(),
  schedule: z.array(z.strictObject({ cron: z.string().regex(/^(\S+\s+){4}\S+$/, "cron must have 5 fields") })).min(1).optional(),
  github: z.strictObject({
    events: z.array(z.enum(["issues.opened", "issues.labeled", "pull_request.opened", "pull_request.closed", "issue_comment.created"])).min(1),
    labels: z.array(z.string()).optional(),
  }).optional(),
}).refine((t) => t.manual || t.schedule || t.github, "on must declare at least one trigger (manual, schedule or github)");

export const STEP_TYPES = ["agent", "shell", "github", "approval", "simulate", "noop"] as const;
export const GITHUB_ACTIONS = ["create-issue", "create-pr", "merge-pr"] as const;

export const StepSchema = z.strictObject({
  id: id("step id"),
  name: z.string().optional(),
  uses: z.enum(STEP_TYPES).describe("agent: run a coding agent driver; shell: run a command; github: GitHub REST action; approval: human gate; simulate: wait and emit outputs; noop: emit outputs"),
  needs: z.union([id("needs"), z.array(id("needs"))]).optional().transform((n) => (n === undefined ? [] : Array.isArray(n) ? n : [n])),
  if: z.string().optional().describe("Expression; the step is skipped when false"),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  run: z.string().optional().describe("Command for uses: shell"),
  secrets: z.array(z.string().regex(SECRET_NAME, "secret names are UPPER_SNAKE env-file keys, never values")).default([])
    .describe("Env-file keys read at run time and passed to the step; values never live in YAML"),
  outputs: z.record(z.string(), z.string()).default({}).describe("Step outputs (expressions over the step result)"),
  timeout_seconds: z.number().positive().max(24 * 3600).optional(),
  retries: z.number().int().min(0).max(10).default(0),
  continue_on_error: z.boolean().default(false),
}).superRefine((s, ctx) => {
  if (s.uses === "github" && !GITHUB_ACTIONS.includes(s.with.action as (typeof GITHUB_ACTIONS)[number])) {
    ctx.addIssue({ code: "custom", message: `with.action must be one of ${GITHUB_ACTIONS.join(", ")}`, path: ["with", "action"] });
  }
  if (s.uses === "github" && !s.secrets.includes("GITHUB_TOKEN")) ctx.addIssue({ code: "custom", message: "github steps must list GITHUB_TOKEN in secrets", path: ["secrets"] });
  if (s.uses === "approval" && s.with.role !== undefined && !ROLES.includes(s.with.role as Role)) {
    ctx.addIssue({ code: "custom", message: `with.role must be one of ${ROLES.join(", ")}`, path: ["with", "role"] });
  }
  if (s.uses === "shell" && !s.run) ctx.addIssue({ code: "custom", message: "uses: shell needs run", path: ["run"] });
  if (s.uses !== "shell" && s.run) ctx.addIssue({ code: "custom", message: "run is only valid with uses: shell", path: ["run"] });
  const d = s.with.driver;
  if (s.uses === "agent" && d !== undefined && !(typeof d === "string" && (["claude-code", "codex"].includes(d) || d.includes("${{")))) {
    ctx.addIssue({ code: "custom", message: "with.driver must be claude-code or codex", path: ["with", "driver"] });
  }
});

export const WorkflowSchema = z.strictObject({
  name: id("name"),
  version: z.union([z.string(), z.number()]).transform(String),
  description: z.string().default(""),
  system: z.boolean().default(false).describe("System-generated (shipped with Cobra); read-only for tenants"),
  template: z.boolean().default(false).describe("A template tenants copy into their own workflow"),
  on: TriggerSchema.default({ manual: true }),
  governance: GovernanceSchema,
  inputs: z.record(z.string().regex(ID, "input names must be lowercase identifiers"), InputSchema).default({}),
  steps: z.array(StepSchema).min(1),
  outputs: z.record(z.string(), z.string()).default({}),
});

export type WorkflowInput = z.infer<typeof InputSchema>;
export type WorkflowStep = z.infer<typeof StepSchema>;
export type Governance = z.infer<typeof GovernanceSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

/** Human-readable zod errors: "steps[1].uses: Invalid option ...". */
export function formatIssues(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((i) => {
    const p = i.path.reduce<string>((acc, k) => (typeof k === "number" ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)), "");
    return `${p || "(root)"}: ${i.message}`;
  });
}

export function workflowJsonSchema(): unknown {
  return { $id: "https://github.com/vicgupta/cobra/workflows/workflow.schema.json", title: "Cobra workflow", ...z.toJSONSchema(WorkflowSchema, { io: "input", unrepresentable: "any" }) };
}
