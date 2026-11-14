// Global (not per-team) engineering task templates, shown on Tasks → Templates.
// Rows live in task_templates (migration 39) so a new template can be added on nova
// without a redeploy: `npm run template:add -- --file template.json`.
import type { DB } from "./db";
import { parseCron } from "./cron";
import { describeCron } from "./schedule";
import type { NotifyOn } from "./tasks";

/** Pill order on Tasks → Templates. Add a row here to introduce a new category. */
export const TEMPLATE_CATEGORIES = [
  { slug: "engineering", label: "Engineering" },
  { slug: "finance", label: "Finance" },
  { slug: "human-resources", label: "Human Resources" },
  { slug: "productivity", label: "Productivity" },
] as const;

export type TemplateCategorySlug = (typeof TEMPLATE_CATEGORIES)[number]["slug"];
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Used when a stored category is missing or no longer in TEMPLATE_CATEGORIES. */
export const DEFAULT_TEMPLATE_CATEGORY: TemplateCategorySlug = "engineering";

const SLUGS = new Set<string>(TEMPLATE_CATEGORIES.map((c) => c.slug));
const LABEL_TO_SLUG = new Map<string, TemplateCategorySlug>([
  ...TEMPLATE_CATEGORIES.map((c) => [c.slug, c.slug] as const),
  ...TEMPLATE_CATEGORIES.map((c) => [c.label.toLowerCase(), c.slug] as const),
]);

/** Existing five packs predate this table; stamp them so they do not show a "New" badge. */
export const SEED_CREATED_AT = Date.UTC(2026, 10, 1); // 1 Nov 2026, 00:00 UTC
export const NEW_TEMPLATE_MS = 7 * 24 * 60 * 60 * 1000;
export const isNewTemplate = (createdAt: number, now = Date.now()) => createdAt <= now && now - createdAt <= NEW_TEMPLATE_MS;

export const SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/;

export type TaskTemplate = {
  id: number;
  slug: string;
  name: string;
  category: TemplateCategorySlug;
  description: string;
  skillName: string;
  skillDescription: string;
  skillBody: string;
  taskName: string;
  cron: string;
  scheduleLabel: string;
  notifyOn: NotifyOn;
  notifyInApp: boolean;
  notifyEmail: boolean;
  mode: "simulated" | "real";
  createdAt: number;
};

export type LibraryPack = Omit<TaskTemplate, "id"> & { key: string; title: string; summary: string; isNew?: boolean };

export function toLibraryPack(t: TaskTemplate, now = Date.now()): LibraryPack {
  return {
    ...t,
    key: t.slug,
    title: t.name,
    summary: t.description,
    isNew: isNewTemplate(t.createdAt, now),
  };
}

export function parseTemplateCategory(raw: string | undefined): TemplateCategorySlug | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  return SLUGS.has(s) ? (s as TemplateCategorySlug) : undefined;
}

export function categoryLabel(slug: string): string {
  return TEMPLATE_CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
}

export const SEED_TEMPLATES: Array<Omit<TaskTemplate, 'id'>> = [
  {
    slug: "morning-brief",
    category: "engineering",
    createdAt: SEED_CREATED_AT,
    name: "Morning PR & issue brief",
    description: "A weekday morning summary of open pull requests and issues in the repo.",
    skillName: "morning-pr-issue-brief",
    skillDescription: "Summarise open pull requests and issues for the team.",
    skillBody: `# Morning PR and issue brief

## List open work
In this repo, list open pull requests and open issues. For each PR: author, title, age, review status, and whether CI is green. For each issue: title, labels, and age. Don't change any files.

## Write the brief
Write a short markdown brief: what landed yesterday if you can tell, what is waiting on review, what is blocked, and the three things most worth attention today. Keep it under a page.

## Report
Return only the brief. Don't open, comment on, or close anything.`,
    taskName: "morning-brief",
    cron: "0 9 * * 1-5",
    scheduleLabel: "Weekdays at 9:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
  {
    slug: "stale-prs",
    category: "engineering",
    createdAt: SEED_CREATED_AT,
    name: "Stale PR reminder",
    description: "Find pull requests with no update for a week and remind the team.",
    skillName: "stale-pr-reminder",
    skillDescription: "List stale pull requests and draft a reminder.",
    skillBody: `# Stale PR reminder

## Find stale pull requests
In this repo, list open pull requests with no new commits, reviews or comments for at least 7 days. Note the author, title, last activity, and who is requested as a reviewer. Don't change any files.

## Draft reminders
For each stale PR, write one short, polite reminder (what is waiting and how long). Don't post the reminder unless this is a real run and the task instructions explicitly say to comment.

## Report
Return a list of stale PRs and the drafted reminders.`,
    taskName: "stale-prs",
    cron: "0 10 * * 1-5",
    scheduleLabel: "Weekdays at 10:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
  {
    slug: "ci-digest",
    category: "engineering",
    createdAt: SEED_CREATED_AT,
    name: "CI failure digest",
    description: "Collect recent CI failures on the default branch and group them.",
    skillName: "ci-failure-digest",
    skillDescription: "Summarise recent CI failures on the default branch.",
    skillBody: `# CI failure digest

## Gather failures
In this repo, look at recent CI / GitHub Actions runs on the default branch and on open pull requests. List the failed or cancelled runs from the last 24 hours: workflow name, branch, commit, and a short error excerpt if one is easy to get. Don't change any files.

## Group and explain
Group failures that look like the same cause. For each group, say how many runs, which PRs or commits are affected, and a likely cause if the logs make it obvious.

## Report
Return a short digest. Don't rerun workflows or push fixes unless the task instructions explicitly ask for a fix.`,
    taskName: "ci-digest",
    cron: "0 8 * * 1-5",
    scheduleLabel: "Weekdays at 8:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
  {
    slug: "review-follow-up",
    category: "engineering",
    createdAt: SEED_CREATED_AT,
    name: "Unanswered review follow-up",
    description: "Find review comments and change requests that haven't been answered.",
    skillName: "unanswered-review-follow-up",
    skillDescription: "Find unanswered review comments and requested changes.",
    skillBody: `# Unanswered review follow-up

## Find unanswered reviews
In this repo, look at open pull requests for review comments, requested changes, or pending reviewers with no reply for at least 2 days. Note the PR, the reviewer, the request, and how long it has been waiting. Don't change any files.

## Draft follow-ups
For each item, write one short follow-up the author or reviewer could use. Don't post comments unless this is a real run and the task instructions explicitly say to comment.

## Report
Return the list and the drafted follow-ups.`,
    taskName: "review-follow-up",
    cron: "0 11 * * 1-5",
    scheduleLabel: "Weekdays at 11:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
  {
    slug: "weekly-health",
    category: "engineering",
    createdAt: SEED_CREATED_AT,
    name: "Weekly repo health",
    description: "A Monday snapshot of PR cycle time, issue backlog, and stale work.",
    skillName: "weekly-repo-health",
    skillDescription: "Weekly snapshot of repo health: PRs, issues, and stale work.",
    skillBody: `# Weekly repo health

## Collect numbers
In this repo, for the last 7 days, collect: PRs opened, merged and still open; average time-to-merge if you can estimate it; issues opened and closed; CI pass rate on the default branch if it is easy to see. Also list PRs and issues with no activity for 14 days or more. Don't change any files.

## Write the snapshot
Write a short weekly health note: what improved, what got stuck, and two or three recommended actions for the coming week.

## Report
Return only the snapshot.`,
    taskName: "weekly-health",
    cron: "0 9 * * 1",
    scheduleLabel: "Mondays at 9:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
];

const COLS = "id, slug, name, category, description, skill_name AS skillName, skill_description AS skillDescription, skill_body AS skillBody, task_name AS taskName, cron, schedule_label AS scheduleLabel, notify_on AS notifyOn, notify_inapp AS notifyInApp, notify_email AS notifyEmail, mode, created_at AS createdAt";

function plain(r: Record<string, unknown>): TaskTemplate {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    name: String(r.name),
    category: r.category as TemplateCategorySlug,
    description: String(r.description),
    skillName: String(r.skillName),
    skillDescription: String(r.skillDescription),
    skillBody: String(r.skillBody),
    taskName: String(r.taskName),
    cron: String(r.cron),
    scheduleLabel: String(r.scheduleLabel),
    notifyOn: r.notifyOn as NotifyOn,
    notifyInApp: !!Number(r.notifyInApp),
    notifyEmail: !!Number(r.notifyEmail),
    mode: r.mode === "real" ? "real" : "simulated",
    createdAt: Number(r.createdAt),
  };
}

export function listTaskTemplates(db: DB, opts: { category?: TemplateCategorySlug } = {}): TaskTemplate[] {
  const sql = opts.category
    ? `SELECT ${COLS} FROM task_templates WHERE category = ? ORDER BY created_at DESC, name, id`
    : `SELECT ${COLS} FROM task_templates ORDER BY created_at DESC, name, id`;
  const rows = (opts.category ? db.prepare(sql).all(opts.category) : db.prepare(sql).all()) as Array<Record<string, unknown>>;
  return rows.map(plain);
}

export function getTaskTemplate(db: DB, slug: string): TaskTemplate | null {
  const r = db.prepare(`SELECT ${COLS} FROM task_templates WHERE slug = ?`).get(slug) as Record<string, unknown> | undefined;
  return r ? plain(r) : null;
}

export function templateCountsByCategory(db: DB): Record<string, number> {
  const out: Record<string, number> = { all: 0 };
  for (const c of TEMPLATE_CATEGORIES) out[c.slug] = 0;
  for (const r of db.prepare("SELECT category, count(*) AS n FROM task_templates GROUP BY category").all() as Array<{ category: string; n: number }>) {
    out[r.category] = Number(r.n);
    out.all += Number(r.n);
  }
  return out;
}

export class TemplateError extends Error {
  constructor(message: string) { super(message); }
}

export type TemplateInput = {
  slug?: unknown;
  name?: unknown;
  title?: unknown;
  category?: unknown;
  description?: unknown;
  summary?: unknown;
  skillName?: unknown;
  skillDescription?: unknown;
  skillBody?: unknown;
  prompt?: unknown;
  steps?: unknown;
  taskName?: unknown;
  cron?: unknown;
  scheduleLabel?: unknown;
  notifyOn?: unknown;
  notifyInApp?: unknown;
  notifyEmail?: unknown;
  delivery?: unknown;
  mode?: unknown;
  createdAt?: unknown;
};

const NOTIFY: NotifyOn[] = ["off", "success", "failure", "both"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalize(input: TemplateInput, now: number): Omit<TaskTemplate, "id"> {
  const name = str(input.name) || str(input.title);
  if (!name) throw new TemplateError("name is required");
  const slug = (str(input.slug) || name).toLowerCase();
  if (!SLUG_RE.test(slug)) throw new TemplateError("slug must be lowercase letters, digits and '-', starting with a letter (max 63)");
  const catRaw = str(input.category).toLowerCase();
  const category = LABEL_TO_SLUG.get(catRaw);
  if (!category) throw new TemplateError(`category must be one of: ${TEMPLATE_CATEGORIES.map((c) => c.slug).join(", ")}`);
  const description = str(input.description) || str(input.summary);
  if (!description) throw new TemplateError("description is required");
  const skillBody = str(input.skillBody) || str(input.prompt) || str(input.steps);
  if (!skillBody) throw new TemplateError("skillBody (prompt/steps) is required");
  const skillName = (str(input.skillName) || slug).toLowerCase();
  if (!SLUG_RE.test(skillName)) throw new TemplateError("skillName must be lowercase letters, digits and '-', starting with a letter (max 63)");
  const taskName = (str(input.taskName) || slug).toLowerCase();
  if (!SLUG_RE.test(taskName)) throw new TemplateError("taskName must be lowercase letters, digits and '-', starting with a letter (max 63)");
  const cron = str(input.cron);
  if (!cron) throw new TemplateError("cron is required");
  try { parseCron(cron); } catch { throw new TemplateError("cron is not a valid schedule"); }
  const scheduleLabel = str(input.scheduleLabel) || describeCron(cron).replace(/^Runs /, "").replace(/^./, (c) => c.toUpperCase());
  let notifyOn: NotifyOn = "both";
  let notifyInApp = true;
  let notifyEmail = false;
  if (input.delivery && typeof input.delivery === "object") {
    const d = input.delivery as Record<string, unknown>;
    if (typeof d.notifyOn === "string" && (NOTIFY as string[]).includes(d.notifyOn)) notifyOn = d.notifyOn as NotifyOn;
    if (typeof d.notifyInApp === "boolean") notifyInApp = d.notifyInApp;
    if (typeof d.notifyEmail === "boolean") notifyEmail = d.notifyEmail;
  }
  if (typeof input.notifyOn === "string") {
    if (!(NOTIFY as string[]).includes(input.notifyOn)) throw new TemplateError("notifyOn must be off, success, failure or both");
    notifyOn = input.notifyOn as NotifyOn;
  }
  if (typeof input.notifyInApp === "boolean") notifyInApp = input.notifyInApp;
  if (typeof input.notifyEmail === "boolean") notifyEmail = input.notifyEmail;
  const mode = input.mode === "real" ? "real" as const : "simulated" as const;
  const createdAt = typeof input.createdAt === "number" && Number.isFinite(input.createdAt) ? input.createdAt : now;
  const skillDescription = str(input.skillDescription) || description;
  return { slug, name, category, description, skillName, skillDescription, skillBody, taskName, cron, scheduleLabel, notifyOn, notifyInApp, notifyEmail, mode, createdAt };
}

function sameContent(a: TaskTemplate, b: Omit<TaskTemplate, "id" | "createdAt">): boolean {
  return a.slug === b.slug && a.name === b.name && a.category === b.category && a.description === b.description
    && a.skillName === b.skillName && a.skillDescription === b.skillDescription && a.skillBody === b.skillBody
    && a.taskName === b.taskName && a.cron === b.cron && a.scheduleLabel === b.scheduleLabel
    && a.notifyOn === b.notifyOn && a.notifyInApp === b.notifyInApp && a.notifyEmail === b.notifyEmail && a.mode === b.mode;
}

const INSERT = `INSERT INTO task_templates (slug, name, category, description, skill_name, skill_description, skill_body, task_name, cron, schedule_label, notify_on, notify_inapp, notify_email, mode, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE = `UPDATE task_templates SET name = ?, category = ?, description = ?, skill_name = ?, skill_description = ?, skill_body = ?, task_name = ?, cron = ?, schedule_label = ?, notify_on = ?, notify_inapp = ?, notify_email = ?, mode = ? WHERE slug = ?`;

function bind(t: Omit<TaskTemplate, "id">) {
  return [t.slug, t.name, t.category, t.description, t.skillName, t.skillDescription, t.skillBody, t.taskName, t.cron, t.scheduleLabel, t.notifyOn, t.notifyInApp ? 1 : 0, t.notifyEmail ? 1 : 0, t.mode, t.createdAt];
}


/** Move rows whose category is not in TEMPLATE_CATEGORIES to Engineering. Safe to re-run. */
export function remapTemplateCategories(db: DB, fallback: TemplateCategorySlug = DEFAULT_TEMPLATE_CATEGORY): number {
  const known = TEMPLATE_CATEGORIES.map((c) => c.slug);
  const ph = known.map(() => "?").join(", ");
  const r = db.prepare(`UPDATE task_templates SET category = ? WHERE category NOT IN (${ph})`).run(fallback, ...known);
  return Number(r.changes);
}

/** Seed the original five packs. INSERT OR IGNORE so a re-run never overwrites daily additions. */
export function seedTaskTemplates(db: DB): void {
  const ins = db.prepare(INSERT.replace('INSERT INTO', 'INSERT OR IGNORE INTO'));
  for (const t of SEED_TEMPLATES) ins.run(...bind(t));
}

export function addTaskTemplate(db: DB, input: TemplateInput, opts: { update?: boolean; now?: number } = {}): { action: "inserted" | "unchanged" | "updated"; template: TaskTemplate } {
  const now = opts.now ?? Date.now();
  const t = normalize(input, now);
  const existing = getTaskTemplate(db, t.slug);
  if (!existing) {
    db.prepare(INSERT).run(...bind(t));
    const row = getTaskTemplate(db, t.slug);
    if (!row) throw new TemplateError("insert failed");
    return { action: "inserted", template: row };
  }
  if (sameContent(existing, t)) return { action: "unchanged", template: existing };
  if (!opts.update) throw new TemplateError(`template '${t.slug}' already exists with different content (pass --update to replace it)`);
  db.prepare(UPDATE).run(t.name, t.category, t.description, t.skillName, t.skillDescription, t.skillBody, t.taskName, t.cron, t.scheduleLabel, t.notifyOn, t.notifyInApp ? 1 : 0, t.notifyEmail ? 1 : 0, t.mode, t.slug);
  const row = getTaskTemplate(db, t.slug);
  if (!row) throw new TemplateError("update failed");
  return { action: "updated", template: row };
}
