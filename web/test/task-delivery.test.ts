// Task result delivery: per-task settings, deliver on finish, filters, no mailbox, error isolation, 60/hr cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openDb, migrate, type DB } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { checkTeamRepo } from "../lib/repos";
import { createAgent } from "../lib/agents";
import { builtinHandlers } from "../lib/workflows/handlers";
import { createSkill, type Actor } from "../lib/skills/store";
import { createTask, getTask, updateTask } from "../lib/tasks";
import { runTask } from "../lib/task-run";
import { deliverTaskResult, reserveTeamEmailSends, TEAM_EMAIL_HOUR_LIMIT, shouldDeliver, formatDuration, extractLinks } from "../lib/task-delivery";
import { listRunNotifications, unreadRunNotificationCount, markRunNotificationsRead } from "../lib/run-notifications";
import * as E from "../lib/team-email";
import type { RunDeps } from "../lib/workflows/service";

const KEY = "a".repeat(64);
const TOKEN = "f00dfacecafe" + "0123456789abcdef".repeat(3) + "beef";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const member = mk("member@a.com", "member", "team-a");
  return { db, member, member2: mk("member2@a.com", "member", "team-a"), lead: mk("lead@a.com", "team_lead", "team-a"), other: mk("m@b.com", "member", "team-b") };
}
const deps = (db: ReturnType<typeof openDb>, t: number): RunDeps => {
  const base = builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, t, r) });
  return { handlers: { ...base, simulate: async (ctx) => ({ ...ctx.with }) }, resolveSecret: () => undefined, redact: () => [] };
};
const sim = (id: string) => ({ id, action: "simulate", with: { v: id }, on_failure: "stop" });
const wait = (ms = 150) => new Promise((res) => setTimeout(res, ms));
const fakeKantsy: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const name = JSON.parse(String(init?.body ?? "")).name as string;
  return new Response(JSON.stringify({ email: `${name}@kantsy.com`, token: TOKEN, tier: "free" }), { status: 201, headers: { "content-type": "application/json" } });
}) as typeof fetch;

test("migration 38: delivery columns default off; existing v37 tasks stay quiet", () => {
  const db = new DatabaseSync(":memory:") as unknown as DB;
  migrate(db, 37);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 37);
  const id = createUser(db, { email: "old@a.com", tenant: "team-a", tenantName: "team-a", role: "member", password: "pw-1234567890" });
  const member = { id, email: "old@a.com", role: "member" as const, tenantId: (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t };
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const now = Date.now();
  const row = db.prepare("INSERT INTO tasks (tenant_id, name, agent, cron, enabled, mode, created_by, created_at, updated_at) VALUES (?, 'legacy', 'rev', NULL, 0, 'simulated', ?, ?, ?)").run(member.tenantId, member.id, now, now);
  const taskId = Number(row.lastInsertRowid);
  migrate(db, 38);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 38);
  const got = getTask(db, member.tenantId, taskId)!;
  assert.equal(got.notifyOn, "off");
  assert.equal(got.notifyEmail, false);
  assert.equal(got.notifyInApp, false);
  assert.deepEqual(got.notifyEmails, []);
});

test("setting persistence: notify fields save and round-trip; recipients must be teammates", () => {
  const { db, member, member2, other } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const t = createTask(db, member, { name: "nightly", agent: "rev" });
  assert.equal(t.notifyOn, "off");
  assert.equal(t.notifyInApp, false);
  const u = updateTask(db, member, t.id, { notifyOn: "failure", notifyInApp: true, notifyEmail: true, notifyEmails: [" Member2@a.com ", "member@a.com"] });
  assert.equal(u.notifyOn, "failure");
  assert.equal(u.notifyInApp, true);
  assert.equal(u.notifyEmail, true);
  assert.deepEqual(u.notifyEmails, ["member2@a.com", "member@a.com"]);
  assert.deepEqual(getTask(db, member.tenantId, t.id)!.notifyEmails, ["member2@a.com", "member@a.com"]);
  assert.throws(() => updateTask(db, member, t.id, { notifyEmails: [other.email] }), /isn't/);
  assert.throws(() => updateTask(db, member, t.id, { notifyOn: "sometimes" }), /off, success, failure or both/);
  assert.equal(member2.email, "member2@a.com");
});

test("delivery triggered on finish: in-app for the team; email to chosen members", async () => {
  const { db, member, member2, lead } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { steps: [sim("a")] } });
  await E.requestTeamEmail(db, lead, { name: "team-a" }, KEY, fakeKantsy);
  const t = createTask(db, member, { name: "brief", agent: "rev", skillRef: `sop:${s.id}`, notifyOn: "both", notifyInApp: true, notifyEmail: true, notifyEmails: [member.email, lead.email] });
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const r = runTask(db, member, member.tenantId, t.id, deps(db, member.tenantId));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const runId = (r.body as { id: string }).id;
  assert.equal((db.prepare("SELECT task_id AS id FROM runs WHERE id = ?").get(runId) as { id: number }).id, t.id);
  await wait(200);
  // Hook already ran (in-app). Re-run delivery with an injected sender to assert email (hook used the real mailbox path).
  // In-app from the hook:
  assert.equal(unreadRunNotificationCount(db, member.id, member.tenantId) >= 1, true);
  assert.equal(unreadRunNotificationCount(db, member2.id, member.tenantId) >= 1, true);
  const mine = listRunNotifications(db, member.id, member.tenantId);
  assert.equal(mine[0].status, "ok");
  assert.match(mine[0].title, /brief: ok/);
  assert.match(mine[0].body, /https:\/\/nova\.kantsy.com\/runs\//);
  assert.equal(mine[0].runId, runId);
  // Explicit second delivery with injected send (in-app will add another row): check email content.
  const again = await deliverTaskResult(db, runId, { send: async (to, subject, body) => { sent.push({ to, subject, body }); } });
  assert.equal(again, "delivered");
  assert.deepEqual(sent.map((s) => s.to).sort(), [lead.email, member.email].sort());
  assert.match(sent[0].subject, /brief: ok/);
  assert.match(sent[0].body, new RegExp(`/runs/${runId}`));
  assert.equal(sent.some((s) => s.to === member2.email), false, "only chosen recipients");
  assert.equal(markRunNotificationsRead(db, member.id, member.tenantId, "all") >= 1, true);
  assert.equal(unreadRunNotificationCount(db, member.id, member.tenantId), 0);
});

test("failure-only filter: success is skipped; failure is delivered", async () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const fail = createSkill(db, member, { name: "boom", description: "d", plan: { steps: [{ id: "x", action: "simulate", with: {}, on_failure: "stop" }] } });
  // A handler that throws on this skill's step:
  const d: RunDeps = {
    handlers: { simulate: async () => { throw new Error("simulated crash"); } },
    resolveSecret: () => undefined, redact: () => [],
  };
  const t = createTask(db, member, { name: "watch", agent: "rev", skillRef: `sop:${fail.id}`, notifyOn: "failure", notifyInApp: true });
  const okSkill = createSkill(db, member, { name: "okflow", description: "d", plan: { steps: [sim("a")] } });
  const t2 = createTask(db, member, { name: "quiet", agent: "rev", skillRef: `sop:${okSkill.id}`, notifyOn: "failure", notifyInApp: true });

  const rOk = runTask(db, member, member.tenantId, t2.id, deps(db, member.tenantId));
  assert.equal(rOk.status, 201);
  await wait(200);
  assert.equal(unreadRunNotificationCount(db, member.id, member.tenantId), 0, "success ignored when notifyOn=failure");

  const rFail = runTask(db, member, member.tenantId, t.id, d);
  assert.equal(rFail.status, 201);
  await wait(200);
  const notes = listRunNotifications(db, member.id, member.tenantId);
  assert.ok(notes.length >= 1, "failure delivered");
  assert.equal(notes[0].status, "failed");
  assert.match(notes[0].title, /watch: failed/);
});

test("email is skipped when the team has no mailbox; in-app still works", async () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { steps: [sim("a")] } });
  assert.equal(E.teamHasMailbox(db, member.tenantId), false);
  const t = createTask(db, member, { name: "nophone", agent: "rev", skillRef: `sop:${s.id}`, notifyOn: "both", notifyInApp: true, notifyEmail: true, notifyEmails: [member.email] });
  const sent: string[] = [];
  const r = runTask(db, member, member.tenantId, t.id, deps(db, member.tenantId));
  assert.equal(r.status, 201);
  await wait(200);
  const runId = (r.body as { id: string }).id;
  await deliverTaskResult(db, runId, { send: async (to) => { sent.push(to); } });
  assert.deepEqual(sent, [], "no email without a mailbox, even with an injected sender");
  assert.ok(unreadRunNotificationCount(db, member.id, member.tenantId) >= 1, "in-app still delivered");
});

test("delivery errors never fail the run", async () => {
  const { db, member, lead } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { steps: [sim("a")] } });
  await E.requestTeamEmail(db, lead, { name: "team-a" }, KEY, fakeKantsy);
  const t = createTask(db, member, { name: "fragile", agent: "rev", skillRef: `sop:${s.id}`, notifyOn: "both", notifyEmail: true, notifyEmails: [member.email] });
  const r = runTask(db, member, member.tenantId, t.id, deps(db, member.tenantId));
  assert.equal(r.status, 201);
  await wait(200);
  const runId = (r.body as { id: string }).id;
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status, "succeeded");
  const result = await deliverTaskResult(db, runId, { send: async () => { throw new Error("smtp down"); } });
  assert.equal(result, "delivered");
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status, "succeeded", "run stays succeeded");
});

test("kantsy 60/hour cap: extra recipients are skipped, not sent", async () => {
  const { db, member, member2, lead } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  const s = createSkill(db, member, { name: "flow", description: "d", plan: { steps: [sim("a")] } });
  await E.requestTeamEmail(db, lead, { name: "team-a" }, KEY, fakeKantsy);
  const t = createTask(db, member, { name: "busy", agent: "rev", skillRef: `sop:${s.id}`, notifyOn: "both", notifyEmail: true, notifyEmails: [member.email, member2.email, lead.email] });
  const r = runTask(db, member, member.tenantId, t.id, deps(db, member.tenantId));
  const runId = (r.body as { id: string }).id;
  await wait(200);
  const now = Date.now();
  // Fill the remaining slots (the finish hook may already have reserved some).
  reserveTeamEmailSends(db, member.tenantId, TEAM_EMAIL_HOUR_LIMIT, now);
  const sent: string[] = [];
  await deliverTaskResult(db, runId, { now, send: async (to) => { sent.push(to); } });
  assert.deepEqual(sent, [], "all skipped at the cap");
});

test("helpers: shouldDeliver, duration, link extraction", () => {
  assert.equal(shouldDeliver("off", true), false);
  assert.equal(shouldDeliver("off", false), false);
  assert.equal(shouldDeliver("success", true), true);
  assert.equal(shouldDeliver("success", false), false);
  assert.equal(shouldDeliver("failure", true), false);
  assert.equal(shouldDeliver("failure", false), true);
  assert.equal(shouldDeliver("both", true), true);
  assert.equal(shouldDeliver("both", false), true);
  assert.equal(formatDuration(4_000), "4s");
  assert.equal(formatDuration(125_000), "2 min 5s");
  const links = extractLinks({ repo: "vicgupta/cobra", issue: 12, outputs: '{"url":"https://github.com/vicgupta/cobra/pull/44"}', error: null });
  assert.deepEqual(links, ["https://github.com/vicgupta/cobra/issues/12", "https://github.com/vicgupta/cobra/pull/44"]);
});

test("task form has a plain delivery section and no JSON", () => {
  const src = readFileSync("components/tasks.tsx", "utf8");
  assert.match(src, /data-task-delivery/);
  assert.match(src, /data-email-hint/);
  assert.match(src, /In-app notification/);
  assert.doesNotMatch(src, /JSON\.stringify\((?!body)/);
});
