// Global task templates: categories, migration 39 seed, add-by-file (idempotent by slug), UI pills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb } from "../lib/db";
import {
  addTaskTemplate, getTaskTemplate, isNewTemplate, listTaskTemplates, NEW_TEMPLATE_MS,
  parseTemplateCategory, SEED_CREATED_AT, SEED_TEMPLATES, TEMPLATE_CATEGORIES, TemplateError,
  templateCountsByCategory,
} from "../lib/task-templates";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("there are at least 10 engineering template categories", () => {
  assert.ok(TEMPLATE_CATEGORIES.length >= 10);
  assert.deepEqual(TEMPLATE_CATEGORIES.map((c) => c.slug), [
    "code-review", "ci-cd", "issues-triage", "pull-requests", "releases", "dependencies",
    "security", "testing", "docs", "repo-health", "performance", "onboarding",
  ]);
  assert.equal(parseTemplateCategory("security"), "security");
  assert.equal(parseTemplateCategory("Templates"), undefined);
  assert.equal(parseTemplateCategory(undefined), undefined);
});

test("migration 39: user_version 39, five global seed packs, no tenant column", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, 38);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 38);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_templates'").get(), undefined);
  migrate(db, 39);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 39);
  const cols = (db.prepare("PRAGMA table_info(task_templates)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!cols.includes("tenant_id"), "templates are global, not per-team");
  assert.ok(cols.includes("slug") && cols.includes("category") && cols.includes("skill_body") && cols.includes("cron") && cols.includes("created_at"));
  const rows = listTaskTemplates(db);
  assert.deepEqual(rows.map((t) => t.slug).sort(), ["ci-digest", "morning-brief", "review-follow-up", "stale-prs", "weekly-health"]);
  assert.equal(getTaskTemplate(db, "morning-brief")?.category, "issues-triage");
  assert.equal(getTaskTemplate(db, "stale-prs")?.category, "pull-requests");
  assert.equal(getTaskTemplate(db, "ci-digest")?.category, "ci-cd");
  assert.equal(getTaskTemplate(db, "review-follow-up")?.category, "code-review");
  assert.equal(getTaskTemplate(db, "weekly-health")?.category, "repo-health");
  assert.equal(getTaskTemplate(db, "morning-brief")?.cron, "0 9 * * 1-5");
  assert.equal(rows.length, SEED_TEMPLATES.length);
  for (const t of rows) assert.equal(t.createdAt, SEED_CREATED_AT);
});

test("openDb seeds templates and reports user_version 39", () => {
  const db = openDb(":memory:");
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 39);
  assert.equal(listTaskTemplates(db).length, 5);
  assert.equal(listTaskTemplates(db, { category: "ci-cd" }).map((t) => t.slug).join(), "ci-digest");
  assert.equal(listTaskTemplates(db, { category: "security" }).length, 0);
  assert.equal(templateCountsByCategory(db).all, 5);
  assert.equal(templateCountsByCategory(db)["ci-cd"], 1);
  assert.equal(templateCountsByCategory(db).security, 0);
});

test("addTaskTemplate is idempotent by slug; --update replaces different content", () => {
  const db = openDb(":memory:");
  const input = {
    slug: "secret-scan", name: "Weekly secret scan", category: "security",
    description: "Look for committed secrets.", skillBody: "# Scan\n\n## Look\nSearch for secrets. Don't change files.\n\n## Report\nReturn the list.",
    cron: "0 9 * * 1", notifyOn: "both", notifyInApp: true, notifyEmail: false, mode: "simulated",
  };
  const a = addTaskTemplate(db, input, { now: Date.UTC(2026, 10, 14) });
  assert.equal(a.action, "inserted");
  assert.equal(a.template.category, "security");
  assert.equal(a.template.taskName, "secret-scan");
  const b = addTaskTemplate(db, input, { now: Date.UTC(2026, 10, 15) });
  assert.equal(b.action, "unchanged");
  assert.equal(b.template.createdAt, a.template.createdAt, "idempotent re-add keeps created_at");
  assert.throws(() => addTaskTemplate(db, { ...input, name: "Renamed" }), (e: unknown) => e instanceof TemplateError && /--update/.test(e.message));
  const c = addTaskTemplate(db, { ...input, name: "Renamed" }, { update: true });
  assert.equal(c.action, "updated");
  assert.equal(c.template.name, "Renamed");
  assert.equal(c.template.createdAt, a.template.createdAt, "update keeps created_at");
  assert.throws(() => addTaskTemplate(db, { ...input, slug: "Bad Name" }), TemplateError);
  assert.throws(() => addTaskTemplate(db, { ...input, slug: "ok", category: "cooking" }), TemplateError);
});

test("New badge: only templates created in the last 7 days", () => {
  const now = Date.UTC(2026, 10, 14, 17);
  assert.equal(isNewTemplate(SEED_CREATED_AT, now), false);
  assert.equal(isNewTemplate(now - NEW_TEMPLATE_MS + 1000, now), true);
  assert.equal(isNewTemplate(now - NEW_TEMPLATE_MS - 1000, now), false);
  assert.equal(isNewTemplate(now + 1000, now), false);
});

test("CLI template:add inserts from a file against a given database", () => {
  const dir = mkdtempSync(join(tmpdir(), "tmpl-"));
  const dbFile = join(dir, "cobra.db");
  const json = join(dir, "t.json");
  writeFileSync(json, JSON.stringify({
    slug: "docs-gap", name: "Docs gap report", category: "docs",
    description: "Find undocumented public APIs.", skillBody: "# Docs\n\n## Look\nList undocumented exports.\n\n## Report\nReturn the list.",
    cron: "0 10 * * 1",
  }));
  const env = { ...process.env, COBRA_DB_PATH: dbFile };
  const run = () => spawnSync("npx", ["tsx", "scripts/template-add.mts", "--file", json], { cwd: new URL("..", import.meta.url), encoding: "utf8", env });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Inserted template 'docs-gap' \(docs\)/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already present/);
  const db = openDb(dbFile);
  assert.equal(getTaskTemplate(db, "docs-gap")?.category, "docs");
});

test("Templates tab has All + category pills, URL-addressable, New badge hook", () => {
  const page = read("app/tasks/page.tsx");
  const pills = read("components/template-category-pills.tsx");
  const lib = read("components/automation-library.tsx");
  assert.match(page, /TemplateCategoryPills/);
  assert.match(page, /parseTemplateCategory/);
  assert.match(pills, /data-testid="template-category-pills"/);
  assert.match(pills, /"All"/);
  assert.match(pills, /\/tasks\?tab=templates&category=\$/);
  assert.match(pills, /rounded-full/);
  assert.match(lib, /data-new/);
  assert.match(lib, /isNew/);
  assert.ok(TEMPLATE_CATEGORIES.length >= 10);
});
