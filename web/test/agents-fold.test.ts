// Oct 2026: Skills folded into Agents. Prompt XOR one skill per agent, loop guard, cron schedule, redirects,
// skill-agent runs on the dashboard's Recent runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { checkTeamRepo } from "../lib/repos";
import { AgentError, checkSkillRef, createAgent, getAgent, updateAgent } from "../lib/agents";
import { builtinHandlers } from "../lib/workflows/handlers";
import { createSkill, updateSkill, type Actor } from "../lib/skills/store";
import { runTeamAgent, scheduleActor } from "../lib/agent-run";
import { tickAgentSchedules } from "../lib/agent-scheduler";
import { cronMatches, nextFire, parseCron } from "../lib/cron";
import { recentRunRows } from "../lib/runs-table";
import { NAV_LINKS } from "../lib/nav-gate";
import nextConfig from "../next.config";
import type { RunDeps } from "../lib/workflows/service";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  return { db, member: mk("member@a.com", "member", "team-a"), other: mk("m@b.com", "member", "team-b") };
}
const deps = (db: ReturnType<typeof openDb>, t: number): RunDeps => {
  const base = builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, t, r) });
  return { handlers: { ...base, simulate: async (ctx) => ({ ...ctx.with }) }, resolveSecret: () => undefined, redact: () => [] };
};
const is400 = (re: RegExp) => (e: unknown) => e instanceof AgentError && e.status === 400 && re.test(e.message);
const sim = (id: string) => ({ id, action: "simulate", with: { v: id }, on_failure: "stop" });
const textDir = () => { const d = mkdtempSync(path.join(tmpdir(), "cobra-ts-")); writeFileSync(path.join(d, "ship.md"), "# Ship\n\nTrigger: ship\n\nGoal: Ship it.\n\nSteps:\n1. Do the thing.\n\nOutput: a summary.\n"); return d; };

test("agents: prompt XOR skill validation (and skill agents store no prompt)", () => {
  const { db, member } = setup();
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { steps: [sim("a")] } });
  assert.throws(() => createAgent(db, member, { name: "x", engine: "codex", kind: "skill", prompt: "p", skillRef: `sop:${s.id}` }), is400(/either a prompt or a skill/));
  assert.throws(() => createAgent(db, member, { name: "x", engine: "codex", kind: "prompt", prompt: "p", skillRef: `sop:${s.id}` }), is400(/either a prompt or a skill/));
  assert.throws(() => createAgent(db, member, { name: "x", engine: "codex", kind: "skill" }), is400(/pick a skill/));
  assert.throws(() => createAgent(db, member, { name: "x", engine: "codex", kind: "prompt" }), is400(/prompt is required/));
  const a = createAgent(db, member, { name: "sk", engine: "codex", kind: "skill", skillRef: `sop:${s.id}` });
  assert.equal(a.prompt, ""); assert.equal(a.skillRef, `sop:${s.id}`);
  const p = createAgent(db, member, { name: "pr", engine: "codex", prompt: "Review" });
  assert.equal(p.skillRef, null);
  // switching kinds clears the other side
  const sw = updateAgent(db, member, "pr", { kind: "skill", skillRef: `sop:${s.id}` });
  assert.equal(sw.prompt, ""); assert.equal(sw.skillRef, `sop:${s.id}`);
  const back = updateAgent(db, member, "pr", { kind: "prompt", prompt: "Again" });
  assert.equal(back.skillRef, null); assert.equal(back.prompt, "Again");
});

test("agents: one skill per agent; SOP by id (team-scoped), text by file name; saving needs no approval", () => {
  const { db, member, other } = setup();
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { steps: [sim("a")] } });
  const theirs = createSkill(db, other, { name: "theirs", description: "d", plan: { steps: [sim("a")] } });
  assert.throws(() => createAgent(db, member, { name: "x", engine: "codex", skillRef: [`sop:${s.id}`, "text:ship"] as unknown as string }), is400(/skillRef must be a string/));
  assert.throws(() => createAgent(db, member, { name: "x", engine: "codex", skillRef: `sop:${s.id},text:ship` }), is400(/not found/));
  assert.throws(() => createAgent(db, member, { name: "x", engine: "codex", skillRef: `sop:${theirs.id}` }), is400(/not found in this team/));
  assert.throws(() => createAgent(db, member, { name: "x", engine: "codex", skillRef: "ship" }), is400(/sop:<id> or text/));
  const d = textDir();
  assert.equal(checkSkillRef(db, member.tenantId, "text:ship", ["x"], d), "text:ship");
  assert.throws(() => checkSkillRef(db, member.tenantId, "text:../etc", ["x"], d), is400(/not found/));
  assert.throws(() => checkSkillRef(db, member.tenantId, "text:nope", ["x"], d), is400(/not found/));
  // a never-approved SOP skill can be saved on an agent and runs for real (no approval gate); the agent step is stubbed
  const a = createAgent(db, member, { name: "y", engine: "codex", skillRef: `sop:${s.id}` });
  assert.equal(a.skillRef, `sop:${s.id}`);
  const d0 = deps(db, member.tenantId);
  const stub: RunDeps = { ...d0, handlers: { ...d0.handlers, agent: async () => ({ status: "succeeded", summary: "stub" }) } };
  const r = runTeamAgent(db, member, "y", { mode: "real" }, stub);
  assert.ok(r.status < 400, `unapproved skill runs: ${JSON.stringify(r.body)}`);
});

test("agents: loop guard refuses a skill whose agent steps (direct or via call_skill) call the same agent", async () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const direct = createSkill(db, member, { name: "direct", description: "d", plan: { steps: [{ id: "a", action: "agent", with: { agent: "rev", prompt: "x" }, on_failure: "stop" }] } });
  createSkill(db, member, { name: "child", description: "c", plan: { steps: [{ id: "a", action: "agent", with: { agent: "looper", prompt: "x" }, on_failure: "stop" }] } });
  const parent = createSkill(db, member, { name: "parent", description: "p", plan: { steps: [{ id: "c", action: "call_skill", skill: "child", on_failure: "stop" }] } });
  assert.throws(() => updateAgent(db, member, "rev", { kind: "skill", skillRef: `sop:${direct.id}` }), is400(/loop: skill 'direct'.*agent 'rev'/));
  assert.throws(() => createAgent(db, member, { name: "looper", engine: "codex", skillRef: `sop:${parent.id}` }), is400(/loop: skill 'parent'.*call_skill.*'looper'/));
  // a different agent may use those skills
  assert.ok(createAgent(db, member, { name: "outer", engine: "codex", skillRef: `sop:${direct.id}` }));
  // run-time depth cap: the skill changed after the agent was saved
  const safe = createSkill(db, member, { name: "safe", description: "s", plan: { steps: [sim("a")] } });
  createAgent(db, member, { name: "later", engine: "codex", skillRef: `sop:${safe.id}` });
  updateSkill(db, member, safe.id, { plan: { steps: [{ id: "a", action: "agent", with: { agent: "later", prompt: "x" }, on_failure: "stop" }] } });
  assert.equal(runTeamAgent(db, member, "later", {}, deps(db, member.tenantId)).status, 409);
});

test("cron: parsing, matching in America/New_York, validation on save; off by default", () => {
  assert.throws(() => parseCron("* * * *"));
  assert.throws(() => parseCron("61 * * * *"));
  assert.throws(() => parseCron("*/0 * * * *"));
  assert.ok(parseCron("*/15 9-17 * * 1-5"));
  assert.ok(parseCron("0 9 * * 7"), "7 = Sunday");
  const nine = Date.UTC(2026, 9, 27, 13, 0); // 9:00 AM EDT, Tuesday
  assert.equal(cronMatches(parseCron("0 9 * * 1-5"), nine), true);
  assert.equal(cronMatches(parseCron("0 9 * * 0,6"), nine), false);
  assert.equal(cronMatches(parseCron("0 9 * * *"), Date.UTC(2026, 11, 1, 14, 0)), true, "9:00 AM EST in winter");
  assert.equal(nextFire(parseCron("0 9 * * *"), nine + 1000), Date.UTC(2026, 9, 28, 13, 0));
  const { db, member } = setup();
  const a = createAgent(db, member, { name: "c", engine: "codex", prompt: "p" });
  assert.equal(a.cron, null); assert.equal(a.cronEnabled, false); assert.equal(a.cronMode, "simulated");
  assert.throws(() => updateAgent(db, member, "c", { cron: "nope" }), is400(/^cron: /));
  assert.throws(() => updateAgent(db, member, "c", { cronEnabled: true }), is400(/set a cron schedule/));
  assert.throws(() => updateAgent(db, member, "c", { cron: "0 9 * * *", cronMode: "fast" }), is400(/cronMode/));
  const b = updateAgent(db, member, "c", { cron: "0  9 * * 1-5", cronEnabled: true });
  assert.equal(b.cron, "0 9 * * 1-5"); assert.equal(b.cronEnabled, true);
  assert.equal(b.contentHash, a.contentHash, "schedule is not part of the version hash");
});

test("scheduler: fires due agents once per minute (no double fire on restart or a second instance)", async () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "due", engine: "codex", prompt: "p", cron: "0 9 * * *", cronEnabled: true });
  createAgent(db, member, { name: "off", engine: "codex", prompt: "p", cron: "0 9 * * *" });
  createAgent(db, member, { name: "later", engine: "codex", prompt: "p", cron: "0 10 * * *", cronEnabled: true });
  const nine = Date.UTC(2026, 9, 27, 13, 0, 2);
  const fired: string[] = [];
  assert.deepEqual(tickAgentSchedules(db, nine, (a) => fired.push(a.name)).map((a) => a.name), ["due"]);
  // same minute again (restart / second instance on the same DB) → nothing
  assert.equal(tickAgentSchedules(db, nine + 30_000, (a) => fired.push(a.name)).length, 0);
  const db2 = db; // a second instance shares the DB row claim
  assert.equal(tickAgentSchedules(db2, nine + 10_000, (a) => fired.push(a.name)).length, 0);
  assert.deepEqual(fired, ["due"]);
  assert.ok(getAgent(db, member.tenantId, "due")!.cronLastFire);
  // next day fires again
  assert.equal(tickAgentSchedules(db, nine + 86_400_000, () => {}).length, 1);
  // a scheduled run records triggered_by 'schedule' and no user
  const r = runTeamAgent(db, scheduleActor(member.tenantId), "due", { mode: "simulated" }, deps(db, member.tenantId), { scheduled: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 50));
  const row = db.prepare("SELECT created_by, triggered_by FROM runs WHERE id = ?").get((r.body as { id: string }).id) as { created_by: number | null; triggered_by: string };
  assert.equal(row.created_by, null); assert.equal(row.triggered_by, "schedule");
});

test("skill-agent runs (SOP and text) and prompt-agent runs are listed in the dashboard's Recent runs", async () => {
  const { db, member } = setup();
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { inputs: { instructions: { type: "string" } }, steps: [sim("a")] } });
  createAgent(db, member, { name: "sop-agent", engine: "codex", skillRef: `sop:${s.id}` });
  createAgent(db, member, { name: "pr-agent", engine: "codex", prompt: "Review" });
  const d = textDir();
  db.prepare("UPDATE team_agents SET skill_ref = 'text:ship', prompt = '' WHERE name = 'pr-agent'").run(); // as if saved with text:ship
  createAgent(db, member, { name: "plain", engine: "codex", prompt: "Hello" });
  const r1 = runTeamAgent(db, member, "sop-agent", { instructions: "focus on tests" }, deps(db, member.tenantId));
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.match((r1.body as { id: string }).id, /^skr_/);
  const r2 = runTeamAgent(db, member, "pr-agent", {}, deps(db, member.tenantId), { textDir: d });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  const r3 = runTeamAgent(db, member, "plain", {}, deps(db, member.tenantId));
  assert.equal(r3.status, 201, JSON.stringify(r3.body));
  await new Promise((res) => setTimeout(res, 100));
  const rows = recentRunRows(db, member.tenantId);
  const ids = rows.map((r) => r.id);
  for (const r of [r1, r2, r3]) assert.ok(ids.includes((r.body as { id: string }).id));
  const sop = rows.find((r) => r.id === (r1.body as { id: string }).id)!;
  assert.equal(sop.kind, "skill"); assert.equal(sop.name, "flow"); assert.equal(sop.triggeredBy, "member");
  assert.equal(rows.find((r) => r.id === (r3.body as { id: string }).id)!.kind, "agent");
});

test("nav and redirects: no Skills nav item; /skills → /agents/skills (permanent, query kept); Dashboard untouched", async () => {
  assert.ok(!(NAV_LINKS as readonly { label: string; href: string }[]).some((l) => l.label === "Skills" || l.href === "/skills"));
  const r = await nextConfig.redirects!();
  const a = r.find((x) => x.source === "/skills")!, b = r.find((x) => x.source === "/skills/:path*")!;
  assert.equal(a.destination, "/agents/skills"); assert.equal(a.permanent, true);
  assert.equal(b.destination, "/agents/skills/:path*"); assert.equal(b.permanent, true);
  const page = readFileSync(path.join(__dirname, "..", "app/page.tsx"), "utf8");
  assert.match(page, /\/skills/, "dashboard keeps its /skills links (served by the redirect)");
  const tabs = readFileSync(path.join(__dirname, "..", "components/agents-tabs.tsx"), "utf8");
  assert.match(tabs, /"Skills library"/);
});
