// Job 22: data for /settings/docs. Field tables are generated from the real zod schema
// (lib/workflows/schema.ts via workflowJsonSchema(), the same source as
// workflows/workflow.schema.json). The handler table is written from lib/workflows/handlers.ts
// and test/docs.test.ts checks it covers exactly STEP_TYPES and GITHUB_ACTIONS. Examples are
// the real files, read verbatim; test/docs.test.ts parses every one with the real loader.
import { readFileSync } from "node:fs";
import path from "node:path";
import { workflowJsonSchema } from "../workflows/schema";
import { workflowsDir, templatesDir } from "../workflows/loader";
import { RUN_FIELDS } from "../workflows/loader";

type JS = { type?: string | string[]; description?: string; default?: unknown; enum?: unknown[]; const?: unknown; pattern?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number; maxLength?: number; minLength?: number; minItems?: number;
  properties?: Record<string, JS>; required?: string[]; items?: JS; anyOf?: JS[]; oneOf?: JS[]; additionalProperties?: JS | boolean; propertyNames?: JS };
export type Field = { name: string; type: string; required: boolean; default?: string; limits: string[]; description: string };

function typeOf(s: JS): string {
  if (s.anyOf || s.oneOf) return [...new Set((s.anyOf ?? s.oneOf)!.map(typeOf))].join(" | ");
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.type === "array") return `list of ${s.items ? typeOf(s.items) : "any"}`;
  if (s.type === "object") return s.properties ? "object" : s.additionalProperties && typeof s.additionalProperties === "object" ? `map of ${typeOf(s.additionalProperties)}` : "object";
  return Array.isArray(s.type) ? s.type.join(" | ") : s.type ?? "any";
}
function limitsOf(s: JS): string[] {
  const l: string[] = [];
  const walk = (x: JS) => {
    if (x.maxLength !== undefined) l.push(`max ${x.maxLength} characters`);
    if (x.minLength !== undefined) l.push(`min ${x.minLength} characters`);
    if (x.minimum !== undefined) l.push(`min ${x.minimum}`);
    if (x.exclusiveMinimum !== undefined) l.push(`> ${x.exclusiveMinimum}`);
    if (x.maximum !== undefined && x.maximum < Number.MAX_SAFE_INTEGER) l.push(`max ${x.maximum}`);
    if (x.minItems !== undefined) l.push(`at least ${x.minItems} item${x.minItems === 1 ? "" : "s"}`);
    if (x.pattern) l.push(`pattern ${x.pattern}`);
    if (x.items) walk(x.items);
    for (const y of x.anyOf ?? x.oneOf ?? []) walk(y);
  };
  walk(s);
  return [...new Set(l)];
}
function fields(obj: JS): Field[] {
  return Object.entries(obj.properties ?? {}).map(([name, s]) => ({
    name, type: typeOf(s), required: !!obj.required?.includes(name) && s.default === undefined,
    default: s.default === undefined ? undefined : JSON.stringify(s.default), limits: limitsOf(s), description: s.description ?? "",
  }));
}
const deref = (s: JS | undefined): JS => (s?.anyOf?.find((x) => x.properties) ?? s?.oneOf?.find((x) => x.properties) ?? s ?? {});

/** Field reference sections, straight from the zod schema. */
export function fieldReference(): Array<{ title: string; path: string; fields: Field[] }> {
  const root = workflowJsonSchema() as JS;
  const p = root.properties!;
  return [
    { title: "Top level", path: "(root)", fields: fields(root) },
    { title: "Triggers", path: "on", fields: fields(deref(p.on)) },
    { title: "Governance", path: "governance", fields: fields(deref(p.governance)) },
    { title: "Each input", path: "inputs.<name>", fields: fields(deref(p.inputs.additionalProperties as JS)) },
    { title: "Each step", path: "steps[]", fields: fields(deref(p.steps.items)) },
  ];
}

export const runFields = RUN_FIELDS;

/** One entry per registered `uses:` handler (and per github action). Written from handlers.ts. */
export type HandlerDoc = { uses: string; action?: string; summary: string; with: Array<[string, string]>; outputs: string; notes?: string };
export const HANDLER_DOCS: HandlerDoc[] = [
  { uses: "simulate", summary: "Waits, then returns its own `with` as the result. Used by test-run.", with: [["duration_ms", "milliseconds to wait (default 0)"], ["(any)", "every other key is echoed back"]], outputs: "result.<key> = each `with` key" },
  { uses: "noop", summary: "Returns its own `with` as the result immediately.", with: [["(any)", "echoed back"]], outputs: "result.<key> = each `with` key" },
  { uses: "shell", summary: "Runs `run` with bash on the Cobra server. Disabled unless the server sets COBRA_WORKFLOW_ALLOW_SHELL=1 (not sandboxed).", with: [["cwd", "working directory (optional)"]], outputs: "result.stdout, result.exit_code (0); a non-zero exit fails the step", notes: "`run` is required for shell and not allowed on any other step. Listed secrets are the only env vars besides PATH and HOME." },
  { uses: "agent", summary: "Runs a coding agent (claude-code or codex). In simulated mode nothing executes.", with: [["driver", "claude-code | codex (or an expression such as ${{ run.engine }}); default claude-code"], ["agent", "a team agent's name instead of driver: the agent fixes engine and prompt, and its hash is folded into approval. Not combinable with driver"], ["mode", "simulated | real (usually ${{ run.mode }})"], ["repo", "owner/name team repo to clone, branch cobra/<run-id> and push (usually ${{ run.repo }})"], ["prompt", "the task (usually ${{ run.prompt }})"]],
    outputs: "real: result.driver, workspace, branch, pushed, files, summary. simulated: result.simulated, driver, summary", notes: "Other keys are accepted by the schema (it is a free map) but are not read by the local runner, e.g. issue, work_dir, job_dir, timeout_minutes in issue-to-pr.yaml." },
  { uses: "github", action: "create-issue", summary: "Opens an issue.", with: [["repo", "owner/name"], ["title", "issue title"], ["body", "optional"]], outputs: "result.number, result.url" },
  { uses: "github", action: "create-pr", summary: "Opens a pull request from an existing branch.", with: [["repo", "owner/name"], ["title", ""], ["head", "branch"], ["base", "default main"], ["body", "optional"]], outputs: "result.number, result.url" },
  { uses: "github", action: "merge-pr", summary: "Merges a PR. No merge-rule check and no audit; prefer `merge`.", with: [["repo", ""], ["pr", "number"], ["merge_method", "default squash"], ["commit_title", "optional"]], outputs: "result.sha, result.merged" },
  { uses: "github", action: "issue_create", summary: "Opens an issue as the run's starter (collab_audit issue_create).", with: [["repo", ""], ["title", "required"], ["body", "optional"], ["mode", "simulated: no GitHub call"]], outputs: "result.number, result.url (simulated: number 0)" },
  { uses: "github", action: "pr_from_issue", summary: "Runs the agent on the issue, pushes cobra/<run-id>, opens a PR whose body starts `Closes #<issue>` (collab_audit pr_create).", with: [["repo", ""], ["issue", "issue number"], ["driver", "claude-code | codex"], ["instructions", "extra prompt text (optional)"], ["base", "default: the repo's default branch"], ["mode", "simulated: no agent, no GitHub"]], outputs: "result.number, url, branch, head_sha, summary" },
  { uses: "github", action: "merge", summary: "Plain merge pinned to the head sha, never forced (collab_audit merge). Only the team's designated lead or a system admin; anyone else fails and the PR stays open, also in simulated mode.", with: [["repo", ""], ["pr", "PR number"], ["sha", "expected head sha (optional; the merge fails if the head moved)"], ["mode", "simulated: gate check only"]], outputs: "result.merged, result.sha" },
  { uses: "approval", summary: "A human gate inside a run. No approval provider is wired in yet, so this step currently always fails with a clear message.", with: [["role", "admin | team_lead | member (optional)"], ["message", "optional"]], outputs: "result.approved, by, comment (once a provider exists)" },
];

/** Every github step: must list GITHUB_TOKEN in secrets (schema rule). The token actually used is the repo's PAT when set, else GITHUB_TOKEN. */
export const GITHUB_NOTE = "Every github step must list GITHUB_TOKEN in `secrets` (schema rule). At run time the server uses the repo's PAT when one is set in Settings > Repos, else GITHUB_TOKEN. Tokens are never put in YAML and are redacted from logs.";

export type Example = { title: string; origin: string; source: string };
const read = (dir: string, f: string) => readFileSync(path.join(dir, f), "utf8");

/** hello-world exists only in nova's database (tenant 1, tenant_workflows), copied verbatim on 2026-10-25. */
export const HELLO_WORLD = `name: hello-world
version: 1
description: Says hello. One simple step that prints a greeting, no repo or agent needed.
on:
  manual: true
governance:
  owner: vicgupta+test@gmail.com
  approvers:
    - role: admin
inputs:
  name:
    type: string
    default: world
steps:
  - id: greet
    uses: simulate
    with:
      duration_ms: 500
      message: Hello, \${{ inputs.name }}!
    outputs:
      message: \${{ result.message }}
outputs:
  message: \${{ steps.greet.outputs.message }}
`;

export function workflowExamples(dir = workflowsDir()): Example[] {
  return [
    { title: "hello-world", origin: "team workflow in the database (verbatim copy)", source: HELLO_WORLD },
    ...["test-run.yaml", "agent-run.yaml", "issue-to-merge-flow.yaml"].map((f) => ({ title: f.replace(/\.yaml$/, ""), origin: `workflows/${f}`, source: read(dir, f) })),
  ];
}
export function templateExamples(dir = templatesDir()): Example[] {
  return ["issue-to-merge.yaml", "cloud-software-factory.yaml"].map((f) => ({ title: f.replace(/\.yaml$/, ""), origin: `workflows/templates/${f}`, source: read(dir, f) }));
}
