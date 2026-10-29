// Oct 2026: Tasks (agent + optional skill on a cron schedule), no JSON in skill views, lowercase names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { checkTeamRepo } from "../lib/repos";
import { AgentError, createAgent, getAgent } from "../lib/agents";
import { builtinHandlers } from "../lib/workflows/handlers";
import { createSkill, SkillError, type Actor } from "../lib/skills/store";
import { createTask, deleteTask, getTask, listTasks, TaskError, updateTask } from "../lib/tasks";
import { runTask, scheduleLabel } from "../lib/task-run";
import { tickTaskSchedules } from "../lib/agent-scheduler";
import { recentRunRows } from "../lib/runs-table";
import { NAV_LINKS } from "../lib/nav-gate";
import type { RunDeps } from "../lib/workflows/service";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const member = mk("member@a.com", "member", "team-a");
  return { db, member, member2: mk("member2@a.com", "member", "team-a"), lead: mk("lead@a.com", "team_lead", "team-a"), dl: mk("dl@a.com", "member", "team-a"), other: mk("m@b.com", "member", "team-b") };
}
const deps = (db: ReturnType<typeof openDb>, t: number): RunDeps => {
  const base = builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, t, r) });
  return { handlers: { ...base, simulate: async (ctx) => ({ ...ctx.with }) }, resolveSecret: () => undefined, redact: () => [] };
};
const sim = (id: string) => ({ id, action: "simulate", with: { v: id }, on_failure: "stop" });
const err = (status: number, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.status === status && (!re || re.test(e.message));

test("migration 31: tasks table, disabled by default", () => {
  const { db, member } = setup();
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 35);
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const t = createTask(db, member, { name: "nightly", agent: "rev", cron: "0 9 * * *" });
  assert.equal(t.enabled, false); assert.equal(t.mode, "simulated"); assert.equal(t.skillRef, null);
});

test("tasks: CRUD, validation and lowercase names", () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { steps: [sim("a")] } });
  const t = createTask(db, member, { name: "  Nightly-Review ", agent: "REV", skillRef: `sop:${s.id}`, cron: "0  9 * * 1-5", enabled: true, instructions: "be brief" });
  assert.equal(t.name, "nightly-review"); assert.equal(t.agent, "rev"); assert.equal(t.cron, "0 9 * * 1-5"); assert.equal(t.enabled, true); assert.equal(t.skillRef, `sop:${s.id}`);
  assert.throws(() => createTask(db, member, { name: "NIGHTLY-review", agent: "rev" }), err(409));
  assert.throws(() => createTask(db, member, { name: "bad name", agent: "rev" }), err(400, /lowercase/));
  assert.throws(() => createTask(db, member, { name: "x", agent: "nope" }), err(400, /not found/));
  assert.throws(() => createTask(db, member, { name: "x", agent: "rev", cron: "nope" }), err(400, /cron/));
  assert.throws(() => createTask(db, member, { name: "x", agent: "rev", enabled: true }), err(400, /cron schedule/));
  assert.throws(() => createTask(db, member, { name: "x", agent: "rev", mode: "fast" }), err(400, /mode/));
  assert.throws(() => createTask(db, member, { name: "x", agent: "rev", skillRef: "sop:9999" }), (e: unknown) => e instanceof AgentError && e.status === 400);
  const u = updateTask(db, member, t.id, { enabled: false, skillRef: null, name: "Renamed" });
  assert.equal(u.enabled, false); assert.equal(u.skillRef, null); assert.equal(u.name, "renamed"); assert.equal(u.cron, "0 9 * * 1-5");
  deleteTask(db, member, t.id);
  assert.equal(getTask(db, member.tenantId, t.id), null); assert.equal(listTasks(db, member.tenantId).length, 0);
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(t.id), "soft delete keeps the row");
  createTask(db, member, { name: "renamed", agent: "rev" }); // name freed
});

test("tasks: permissions mirror agents; other teams get 404", () => {
  const { db, member, member2, lead, dl, other } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const t = createTask(db, member, { name: "t1", agent: "rev" });
  assert.throws(() => updateTask(db, member2, t.id, { cron: "0 9 * * *" }), err(403));
  assert.throws(() => deleteTask(db, member2, t.id), err(403));
  assert.equal(updateTask(db, lead, t.id, { mode: "real" }).mode, "real");
  db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(dl.id, dl.tenantId);
  assert.equal(updateTask(db, dl, t.id, { mode: "simulated" }).mode, "simulated");
  assert.equal(getTask(db, other.tenantId, t.id), null);
  assert.throws(() => updateTask(db, other, t.id, { mode: "real" }), err(404));
  assert.throws(() => deleteTask(db, other, t.id), err(404));
  assert.equal(listTasks(db, other.tenantId).length, 0);
  assert.equal(runTask(db, other, other.tenantId, t.id, deps(db, other.tenantId)).status, 404);
  // a task can't use another team's agent
  assert.throws(() => createTask(db, other, { name: "t1", agent: "rev" }), err(400, /not found/));
});

test("scheduler: fires a due enabled task exactly once (restart / second instance), never disabled ones", async () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const due = createTask(db, member, { name: "due", agent: "rev", cron: "0 9 * * *", enabled: true });
  createTask(db, member, { name: "off", agent: "rev", cron: "0 9 * * *" });
  createTask(db, member, { name: "later", agent: "rev", cron: "0 10 * * *", enabled: true });
  const nine = Date.UTC(2026, 9, 27, 13, 0, 2); // 9:00 America/New_York (EDT)
  const fired: string[] = [];
  const fire = (t: { id: number; tenantId: number; name: string }) => { fired.push(t.name); runTask(db, null, t.tenantId, t.id, deps(db, t.tenantId), { scheduled: true }); };
  assert.deepEqual(tickTaskSchedules(db, nine, fire).map((t) => t.name), ["due"]);
  assert.equal(tickTaskSchedules(db, nine + 30_000, fire).length, 0);
  assert.equal(tickTaskSchedules(db, nine + 10_000, fire).length, 0);
  assert.deepEqual(fired, ["due"]);
  await new Promise((res) => setTimeout(res, 100));
  const runs = db.prepare("SELECT created_by, triggered_by, simulated FROM runs").all() as Array<{ created_by: number | null; triggered_by: string; simulated: number }>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].created_by, null); assert.equal(runs[0].triggered_by, scheduleLabel(due)); assert.equal(runs[0].triggered_by, "task due (schedule)");
  assert.ok(getTask(db, member.tenantId, due.id)!.lastFire);
  assert.equal(tickTaskSchedules(db, nine + 86_400_000, () => {}).length, 1); // next day
});

test("task runs (prompt agent, SOP skill override; built-in text skill refused) show in the dashboard's Recent runs", async () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { inputs: { instructions: { type: "string" } }, steps: [sim("a")] } });
  const a = createTask(db, member, { name: "plain", agent: "rev", instructions: "be brief" });
  const b = createTask(db, member, { name: "sop", agent: "rev", skillRef: `sop:${s.id}` });
  assert.throws(() => createTask(db, member, { name: "text", agent: "rev", skillRef: "text:ship" }), (e: unknown) => /built-in skills were removed/.test((e as Error).message));
  const r1 = runTask(db, member, member.tenantId, a.id, deps(db, member.tenantId));
  const r2 = runTask(db, member, member.tenantId, b.id, deps(db, member.tenantId));
  for (const r of [r1, r2]) assert.equal(r.status, 201, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 150));
  const rows = recentRunRows(db, member.tenantId), ids = rows.map((r) => r.id);
  for (const r of [r1, r2]) assert.ok(ids.includes((r.body as { id: string }).id));
  assert.equal(rows.find((r) => r.id === (r2.body as { id: string }).id)!.name, "flow");
  assert.equal(rows.find((r) => r.id === (r1.body as { id: string }).id)!.triggeredBy, "member");
  const sims = db.prepare("SELECT simulated FROM runs").all() as Array<{ simulated: number }>;
  assert.ok(sims.every((x) => x.simulated === 1), "task runs default to simulated");
  assert.ok(getAgent(db, member.tenantId, "rev")!.skillRef === null, "the agent itself is unchanged");
  for (const [t, r] of [[a, r1], [b, r2]] as const) assert.equal(getTask(db, member.tenantId, t.id)!.lastRun?.id, (r.body as { id: string }).id, "last run is linked to the task");
  assert.equal(getTask(db, member.tenantId, a.id)!.lastRun!.id.length > 0, true);
});

test("nav: Dashboard, Tasks, Agents, Repos, Settings; Tasks page and API exist", () => {
  assert.deepEqual(NAV_LINKS.map((l) => l.label), ["Dashboard", "Tasks", "Agents", "Repos", "Settings"]);
  for (const f of ["app/tasks/page.tsx", "app/api/tasks/route.ts", "app/api/tasks/[id]/route.ts", "app/api/tasks/[id]/runs/route.ts"]) assert.ok(readFileSync(f, "utf8").length > 0, f);
});

test("agent form: no per-agent cron fields (scheduling lives in Tasks)", () => {
  const src = readFileSync("components/agents.tsx", "utf8");
  assert.doesNotMatch(src, /data-agent-cron|cronEnabled: cronEnabled|aria-label="Cron schedule"/);
});

test("skill views never show JSON (no JSON.stringify / <pre> dumps / plan textarea)", () => {
  for (const f of ["app/agents/skills/page.tsx", "app/agents/skills/[id]/page.tsx", "app/agents/skills/[id]/edit/page.tsx", "app/tasks/page.tsx", "app/agents/page.tsx"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /JSON\.stringify/, f); assert.doesNotMatch(src, /<pre/, f);
  }
  const editor = readFileSync("components/skills.tsx", "utf8");
  assert.doesNotMatch(editor, /Plan \(JSON|JSON\.stringify\(s\.plan|setPlan\(e\.target/);
  const tasks = readFileSync("components/tasks.tsx", "utf8");
  assert.doesNotMatch(tasks, /<pre|\.plan\b|JSON\.stringify\((?!body)/);
  const agents = readFileSync("components/agents.tsx", "utf8");
  assert.doesNotMatch(agents, /\{o\.label\} · \{o\.status\}/);
});

test("lowercase names: agents and skills are normalized; no title-casing in the skills list", () => {
  const { db, member } = setup();
  assert.equal(createAgent(db, member, { name: "Reviewer", engine: "codex", prompt: "p" }).name, "reviewer");
  assert.equal(createSkill(db, member, { name: "Release-Checklist", description: "d", body: "Do it." }).name, "release-checklist");
  assert.throws(() => createSkill(db, member, { name: "RELEASE-checklist", description: "d", body: "x" }), (e: unknown) => e instanceof SkillError && e.status === 409);
  const lib = readFileSync("app/agents/skills/page.tsx", "utf8");
  assert.doesNotMatch(lib, /toUpperCase/);
  const list = readFileSync("components/skills.tsx", "utf8");
  assert.doesNotMatch(list, /toUpperCase/); assert.match(list, /\{r\.name\}/);
});
