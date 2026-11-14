// Tasks section tabs: Current (task list, default) and Templates (automation library).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTasksTab } from "../lib/tasks-tabs";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("parseTasksTab: templates is explicit; anything else is Current", () => {
  assert.equal(parseTasksTab("templates"), "templates");
  assert.equal(parseTasksTab(undefined), "current");
  assert.equal(parseTasksTab("current"), "current");
  assert.equal(parseTasksTab("Templates"), "current");
  assert.equal(parseTasksTab("other"), "current");
});

test("Tasks page has Current and Templates tabs, URL-addressable, default Current", () => {
  const page = read("app/tasks/page.tsx");
  const tabs = read("components/tasks-tabs.tsx");
  assert.match(page, /TasksTabs/);
  assert.match(page, /parseTasksTab/);
  assert.match(page, /searchParams/);
  assert.match(page, /highlightTaskId/);
  assert.match(tabs, /data-testid="tasks-tabs"/);
  assert.match(tabs, /"Current"/);
  assert.match(tabs, /"Templates"/);
  assert.match(tabs, /tab\("\/tasks\?tab=templates"/);
  assert.match(tabs, /tab\("\/tasks", "Current"/);
  // Same typography/colors as Settings / admin / Agents tabs
  assert.match(tabs, /border-b border-border/);
  assert.match(tabs, /bg-surface-2 font-medium text-fg/);
  assert.match(tabs, /text-muted hover:bg-surface hover:text-fg/);
  // Library only on the Templates tab; task list only on Current
  assert.match(page, /tab === "templates"/);
  assert.match(page, /AutomationLibrary/);
  assert.match(page, /TaskManager/);
});

test("creating a template task sends the user to Current with the new task highlighted", () => {
  const lib = read("components/automation-library.tsx");
  const tasks = read("components/tasks.tsx");
  assert.match(lib, /\/tasks\?tab=current&task=\$/);
  assert.match(tasks, /highlightTaskId/);
  assert.match(tasks, /data-highlight/);
  assert.match(tasks, /scrollIntoView/);
  assert.match(tasks, /id=\{`task-\$\{t\.id\}`\}/);
  assert.match(tasks, /bg-surface-2/);
});
