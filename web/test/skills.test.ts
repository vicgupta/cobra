import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { builtinHandlers } from "../lib/workflows/handlers";
import { validatePlan, MAX_STEPS } from "../lib/skills/plan";
import { sections, sectionText } from "../lib/skills/sections";
import { canEdit, createSkill, effectiveHash, getSkill, listSkills, skillByName, updateSkill, type Actor } from "../lib/skills/store";
import { startSkillRun, type SkillDeps } from "../lib/skills/executor";
import * as svc from "../lib/skills/service";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: Actor["role"], tenant = "default") => {
    const id = createUser(db, { email, tenant, tenantName: tenant === "default" ? undefined : `Team ${tenant}`, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  return { db, admin: mk("vicgupta@gmail.com", "admin"), lead: mk("lead@x.com", "team_lead"), member: mk("member@x.com", "member"), member2: mk("m2@x.com", "member"), bMember: mk("bee@other.com", "member", "other"), bLead: mk("leadb@other.com", "team_lead", "other") };
}
const base = builtinHandlers({});
const deps: SkillDeps = {
  handlers: { ...base, simulate: async (ctx) => { if (ctx.with.fail === "yes") throw new Error("boom"); return { ...ctx.with }; } },
  resolveSecret: () => undefined, redact: () => [],
};
// real-mode tests: the agent step is stubbed so nothing real ever runs
const stubDeps: SkillDeps = { ...deps, handlers: { ...deps.handlers, agent: async () => ({ status: "succeeded", summary: "stub" }) } };
const who = (u: Actor) => ({ tenantId: u.tenantId, userId: u.id, email: u.email });
const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, action: "simulate", with: { v: id }, on_failure: "stop", outputs: { v: "result.v" }, ...extra });

test("plan schema: valid plan, strict unknown keys, semantic errors", () => {
  assert.equal(validatePlan({ steps: [step("a")] }).ok, true);
  const bad = validatePlan({ steps: [{ id: "a", action: "nope" }] });
  assert.equal(bad.ok, false);
  assert.equal(validatePlan({ steps: [step("a", { extra: 1 })] }).ok, false);
  const sem = validatePlan({ steps: [step("a", { handoffs: [{ from: "steps.b.outputs.v", to: "x" }], with: { v: "{{x}}" } }), step("b")] });
  assert.equal(sem.ok, false);
  assert.match((sem as { errors: string[] }).errors.join(" "), /b/);
  assert.equal(validatePlan({ steps: [step("a", { with: { v: "{{undeclared}}" } })] }).ok, false);
  assert.equal(validatePlan({ steps: [step("a", { on_failure: { goto: "a" } })] }).ok, false, "goto must be forward");
  assert.equal(validatePlan({ steps: [step("a"), step("a")] }).ok, false, "duplicate ids");
  assert.equal(validatePlan(JSON.stringify({ steps: [step("a")] })).ok, true, "JSON text accepted");
});

test("executor (simulate): when conditions, handoffs, on_failure continue/goto/stop", async () => {
  const { db, member } = setup();
  const plan = {
    inputs: { who: { type: "string", default: "world" } },
    steps: [
      step("greet", { with: { v: "hello {{name}}" }, handoffs: [{ from: "inputs.who", to: "name" }] }),
      step("skipme", { when: "inputs.who == 'nobody'" }),
      step("bad", { with: { fail: "yes", v: "x" }, on_failure: "continue" }),
      step("bad2", { with: { fail: "yes", v: "x" }, on_failure: { goto: "verify" } }),
      step("jumped"),
      step("verify", { with: { v: "got {{g}}" }, handoffs: [{ from: "steps.greet.outputs.v", to: "g" }], when: "steps.bad.status == 'failed'" }),
    ],
    outputs: { final: "steps.verify.outputs.v" },
  };
  const s = createSkill(db, member, { name: "flow", description: "d", body: "# Flow", plan });
  const r = await startSkillRun(db, who(member), s, { who: "Ann" }, deps).done;
  assert.equal(r.status, "succeeded");
  assert.equal(r.steps.greet.outputs.v, "hello Ann");
  assert.equal(r.steps.skipme.status, "skipped");
  assert.equal(r.steps.bad.status, "failed");
  assert.equal(r.steps.jumped.status, "pending", "goto skipped it");
  assert.equal(r.outputs.final, "got hello Ann");
  const s2 = createSkill(db, member, { name: "stopper", description: "d", plan: { steps: [step("x", { with: { fail: "yes", v: "1" } }), step("after")] } });
  const r2 = await startSkillRun(db, who(member), s2, {}, deps).done;
  assert.equal(r2.status, "failed");
  assert.equal(r2.steps.after.status, "pending");
  const row = db.prepare("SELECT workflow, status, mode FROM runs WHERE id = ?").get(r2.id) as { workflow: string; status: string; mode: string };
  assert.deepEqual({ ...row }, { workflow: "skill:stopper", status: "failed", mode: "simulated" });
  assert.ok((db.prepare("SELECT COUNT(*) n FROM run_step_events WHERE run_id = ?").get(r.id) as { n: number }).n > 6);
});

test("listing skills on an empty team creates nothing (no seeded master or built-in skill)", () => {
  const { db, member, bMember } = setup();
  const count = () => (db.prepare("SELECT COUNT(*) n FROM skills").get() as { n: number }).n;
  assert.equal(count(), 0);
  assert.deepEqual(listSkills(db, member), []);
  assert.deepEqual(listSkills(db, bMember), []);
  listSkills(db, member);
  assert.equal(count(), 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM skills WHERE kind = 'master' OR builtin = 1 OR name = 'workflow'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM skill_versions").get() as { n: number }).n, 0);
});

test("master skill: user-created, composition with input mapping, own runs per child, cycles and depth cap", async () => {
  const { db, member, lead } = setup();
  const m = createSkill(db, member, { name: "workflow", description: "my master", kind: "master", body: "# Workflow" });
  assert.equal(m.kind, "master");
  assert.equal(m.builtin, false);
  assert.equal(m.plan.steps.length, 2, "starts from the master plan");
  createSkill(db, member, { name: "child", description: "c", plan: { inputs: { topic: { type: "string", required: true } }, steps: [step("work", { with: { v: "did {{t}}" }, handoffs: [{ from: "inputs.topic", to: "t" }] })], outputs: { result: "steps.work.outputs.v" } } });
  const plan = { inputs: { goal: { type: "string", required: true } }, steps: [
    { id: "call", action: "call_skill", skill: "child", with: { topic: "{{g}}" }, handoffs: [{ from: "inputs.goal", to: "g" }], on_failure: "stop", outputs: { r: "result.result" } },
    { id: "verify", action: "simulate", with: { v: "{{r}}" }, handoffs: [{ from: "steps.call.outputs.r", to: "r" }], when: "steps.call.status == 'succeeded'", on_failure: "stop", outputs: { v: "result.v" } }],
    outputs: { out: "steps.verify.outputs.v" } };
  const { skill: master } = updateSkill(db, lead, m.id, { plan });
  const r = await startSkillRun(db, who(member), master, { goal: "tests" }, deps).done;
  assert.equal(r.status, "succeeded", r.error);
  assert.equal(r.outputs.out, "did tests");
  const childRun = r.steps.call.childRun!;
  assert.equal((db.prepare("SELECT workflow FROM runs WHERE id = ?").get(childRun) as { workflow: string }).workflow, "skill:child");
  // cycle: child calls workflow → rejected at save
  assert.throws(() => updateSkill(db, member, skillByName(db, member.tenantId, "child")!.id, { plan: { steps: [{ id: "c", action: "call_skill", skill: "workflow", on_failure: "stop" }] } }), /cycle/);
  // depth cap: a chain of 6
  createSkill(db, member, { name: "d0", description: "x", plan: { steps: [step("a")] } });
  for (let i = 1; i <= 5; i++) {
    const f = () => createSkill(db, member, { name: `d${i}`, description: "x", plan: { steps: [{ id: "c", action: "call_skill", skill: `d${i - 1}`, on_failure: "stop" }] } });
    if (i <= 4) f(); else assert.throws(f, /deeper than 4/);
  }
});

test("effective hash covers body, plan, composed skills (recursive) and agents", () => {
  const { db, member } = setup();
  const leaf = createSkill(db, member, { name: "leaf", description: "l", plan: { steps: [step("a")] } });
  createSkill(db, member, { name: "mid", description: "m", plan: { steps: [{ id: "c", action: "call_skill", skill: "leaf", on_failure: "stop" }] } });
  const top = createSkill(db, member, { name: "top", description: "t", body: "# Top", plan: { steps: [{ id: "c", action: "call_skill", skill: "mid", on_failure: "stop" }] } });
  const h1 = effectiveHash(db, top).hash;
  updateSkill(db, member, leaf.id, { plan: { steps: [step("a"), step("b")] } });
  const top2 = getSkill(db, member, top.id)!;
  assert.notEqual(effectiveHash(db, top2).hash, h1, "grandchild change changes the hash");
  updateSkill(db, member, top.id, { body: "# Top v2" });
  assert.notEqual(effectiveHash(db, getSkill(db, member, top.id)!).hash, effectiveHash(db, top2).hash, "body change");
  // hash includes agent
  db.prepare("INSERT INTO team_agents (tenant_id, name, engine, prompt, content_hash, created_at, updated_at) VALUES (?, 'rev', 'claude-code', 'p', 'h1', 0, 0)").run(member.tenantId);
  const ag = createSkill(db, member, { name: "ag", description: "a", plan: { steps: [{ id: "a", action: "agent", with: { agent: "rev", prompt: "x" }, on_failure: "stop" }] } });
  const ha = effectiveHash(db, ag).hash;
  db.prepare("UPDATE team_agents SET content_hash = 'h2' WHERE name = 'rev'").run();
  assert.notEqual(effectiveHash(db, ag).hash, ha);
});

test("team scoping: create/view/edit within team, 404 across teams, system admins included", () => {
  const { db, member, member2, lead, admin, bMember, bLead } = setup();
  const s = createSkill(db, member, { name: "mine", description: "d", body: "one line" });
  const b = createSkill(db, bMember, { name: "theirs", description: "d", body: "x" });
  assert.ok(createSkill(db, lead, { name: "leads", description: "d", body: "y" }));
  assert.equal(getSkill(db, bMember, s.id), null);
  assert.equal(svc.detail(db, bLead, s.id).status, 404);
  assert.equal(svc.update(db, bLead, s.id, { body: "hack" }).status, 404);
  assert.equal(svc.run(db, bMember, s.id, {}, deps).status, 404);
  assert.ok(!listSkills(db, member).some((x) => x.name === "theirs"));
  // the system admin lives in this test's team "x"; team "other"'s skill stays invisible to them
  assert.ok(!listSkills(db, admin).some((x) => x.id === b.id) && listSkills(db, admin).some((x) => x.id === s.id));
  assert.equal(getSkill(db, admin, b.id), null);
  assert.equal(svc.detail(db, admin, b.id).status, 404);
  assert.equal(svc.run(db, admin, b.id, {}, deps).status, 404);
  assert.equal(svc.update(db, admin, b.id, { body: "x" }).status, 404);
  assert.equal(canEdit(db, admin, b), false, "no cross-team edits, even for system admins");
  assert.equal(canEdit(db, member, s), true); assert.equal(canEdit(db, member2, s), false); assert.equal(canEdit(db, lead, s), true); assert.equal(canEdit(db, admin, s), true);
  assert.equal(svc.update(db, member2, s.id, { body: "edit" }).status, 403);
  assert.equal(svc.update(db, lead, s.id, { body: "lead edit" }).status, 200);
  assert.throws(() => createSkill(db, member, { name: "mine", body: "dup" }), /already exists/);
});

test("one-line skill: derived plan, validates, runs in simulate", async () => {
  const { db, member } = setup();
  const s = createSkill(db, member, { name: "tiny", description: "t", body: "Fix the flaky test." });
  assert.equal(s.plan.steps.length, 1);
  assert.equal(s.plan.steps[0].action, "agent");
  assert.equal(s.plan.steps[0].on_failure, "stop");
  assert.ok("prompt" in s.plan.inputs);
  assert.deepEqual(Object.keys(s.plan.outputs).sort(), ["status", "summary"]);
  assert.equal(validatePlan(s.plan).ok, true);
  const r = await startSkillRun(db, who(member), s, { prompt: "be quick" }, deps).done;
  assert.equal(r.status, "succeeded", r.error);
  assert.equal(r.outputs.status, "succeeded");
  assert.match(String(r.outputs.summary), /Simulated .*Fix|SOP/);
  // no approval gate: a freshly saved (never approved) skill runs, real mode included, by a plain member
  const real = startSkillRun(db, who(member), s, { prompt: "go" }, stubDeps, { mode: "real" });
  assert.ok(real.id); await real.done;
});

test("huge skill: 1000+ line body, 200+ steps, section extraction, handoffs and conditions intact", async () => {
  const { db, member } = setup();
  const lines: string[] = ["# Big SOP", "Intro"];
  for (let i = 0; i < 250; i++) lines.push(`## Part ${i}`, `Do part ${i} carefully.`, "```", `# not a heading ${i}`, "```", "");
  const body = lines.join("\n");
  assert.ok(body.split("\n").length > 1000);
  const secs = sections(body);
  assert.equal(secs.length, 251);
  assert.equal(sectionText(body, "part-7")!.includes("Do part 7"), true);
  assert.equal(sectionText(body, "part-7")!.includes("part 8"), false);
  const steps: unknown[] = [];
  for (let i = 0; i < 240; i++) steps.push({ id: `s${i}`, action: i % 2 ? "agent" : "simulate", section: i % 2 ? `part-${i}` : undefined,
    with: i % 2 ? { prompt: "step {{p}}" } : { v: `v${i}` }, handoffs: i % 2 ? [{ from: `steps.s${i - 1}.outputs.v`, to: "p" }] : [],
    when: i % 10 === 9 ? "inputs.skip != true" : undefined, on_failure: "stop", outputs: i % 2 ? { summary: "result.summary" } : { v: "result.v" } });
  steps.push({ id: "verify", action: "simulate", with: { v: "ok" }, on_failure: "stop", outputs: { v: "result.v" } });
  const s = createSkill(db, member, { name: "big", description: "big", body, plan: { inputs: { skip: { type: "boolean", default: true } }, steps } });
  assert.equal(s.plan.steps.length, 241);
  const r = await startSkillRun(db, who(member), s, {}, deps).done;
  assert.equal(r.status, "succeeded", r.error);
  assert.equal(r.steps.s9.status, "skipped");
  assert.equal(r.steps.s19.status, "skipped");
  assert.match(String(r.steps.s3.outputs.summary), /step v2/);
  assert.match(String(r.steps.s3.outputs.summary), /SOP section #part-3/);
  assert.doesNotMatch(String(r.steps.s3.outputs.summary), /Do part 4 /);
  assert.ok(MAX_STEPS >= 2000);
  assert.throws(() => createSkill(db, member, { name: "badsec", body: "# A", plan: { steps: [{ id: "a", action: "agent", section: "nope", with: { prompt: "x" }, on_failure: "stop" }] } }), /no heading 'Nope'/);
  // no length rejection between tiny and huge
  for (const n of [1, 30000, 300000]) assert.equal(svc.create(db, member, { name: `len-${n}`, body: "x".repeat(n) }).status, 201);
});

test("github steps: default to the run's repo/mode; simulated runs never call GitHub (create-pr included)", async () => {
  const { db, member } = setup();
  const s = createSkill(db, member, { name: "gh", description: "d", plan: { steps: [
    { id: "issue", action: "github", with: { action: "issue_create", title: "t", body: "b" }, on_failure: "stop", outputs: { n: "result.number" } },
    { id: "pr", action: "github", with: { action: "create-pr", title: "t", head: "x", base: "main" }, on_failure: "stop", outputs: { u: "result.url" } }] } });
  let called = 0;
  const spy: SkillDeps = { ...deps, handlers: { ...deps.handlers, github: async () => { called++; return {}; } } };
  const r = await startSkillRun(db, who(member), s, {}, spy, { repo: "acme/app" }).done;
  assert.equal(r.status, "succeeded", r.error);
  assert.equal(called, 0, "simulated runs never call GitHub");
});

test("any length, explicit: huge skill with sections, when, handoffs and goto; per-step sections; timing; no length rejection", async () => {
  const { db, member } = setup();
  const lines: string[] = ["# Huge SOP"];
  for (let i = 0; i < 260; i++) lines.push(`## Part ${i}`, `Do part ${i} carefully.`, `Check part ${i}.`, "");
  const body = lines.join("\n");
  assert.ok(body.split("\n").length >= 1000);
  const steps: Record<string, unknown>[] = [];
  for (let i = 0; i < 220; i++) {
    const agentStep = i % 2 === 1;
    steps.push({ id: `s${i}`, action: agentStep ? "agent" : "simulate", ...(agentStep ? { section: `part-${i}` } : {}),
      with: agentStep ? { prompt: "work on {{p}}" } : { v: `v${i}`, ...(i === 100 ? { fail: "yes" } : {}) },
      handoffs: agentStep ? [{ from: `steps.s${i - 1}.outputs.v`, to: "p" }] : [],
      ...(i % 10 === 9 ? { when: "inputs.skip != true" } : {}),
      on_failure: i === 100 ? { goto: "s110" } : "stop", outputs: agentStep ? { summary: "result.summary" } : { v: "result.v" } });
  }
  steps.push({ id: "verify", action: "simulate", with: { v: "ok" }, on_failure: "stop", outputs: { v: "result.v" } });
  const t0 = Date.now();
  const s = createSkill(db, member, { name: "huge2", description: "huge", body, plan: { inputs: { skip: { type: "boolean", default: true } }, steps } });
  assert.equal(validatePlan(s.plan).ok, true);
  assert.equal(s.plan.steps.length, 221);
  const r = await startSkillRun(db, who(member), s, {}, deps).done;
  const ms = Date.now() - t0;
  assert.equal(r.status, "succeeded", r.error);
  assert.ok(ms < 15000, `create + simulated run took ${ms}ms`);
  // goto: s100 fails, s101..s109 are jumped over, s110 runs
  assert.equal(r.steps.s100.status, "failed");
  for (let i = 101; i < 110; i++) assert.ok(["pending", "skipped"].includes(r.steps[`s${i}`].status), `s${i} not run`);
  assert.equal(r.steps.s110.status, "succeeded");
  assert.equal(r.steps.s19.status, "skipped", "when condition");
  // per-step section extraction: each agent step gets exactly its own section
  for (let i = 1; i < 220; i += 2) {
    const sec = sectionText(body, `part-${i}`)!;
    assert.ok(sec.includes(`Do part ${i} carefully.`) && sec.includes(`Check part ${i}.`) && !sec.includes(`part ${i + 1}`), `section ${i}`);
    const st = r.steps[`s${i}`];
    if (st.status !== "succeeded") continue;
    assert.match(String(st.outputs.summary), new RegExp(`SOP section #part-${i}\\b`));
    assert.match(String(st.outputs.summary), new RegExp(`work on v${i - 1}\\b`), "handoff");
  }
  // no length rejection anywhere between one line and huge
  for (const n of [1, 10, 100, 1000, 10000, 100000, 500000]) {
    const sk = createSkill(db, member, { name: `sweep-${n}`, description: "d", body: Array.from({ length: Math.max(1, Math.floor(n / 20)) }, (_, k) => `Line ${k} of the SOP.`).join("\n").slice(0, Math.max(n, 1)) });
    assert.equal(validatePlan(sk.plan).ok, true, `len ${n}`);
    assert.equal((await startSkillRun(db, who(member), sk, {}, deps).done).status, "succeeded", `len ${n}`);
  }
});

test("no rulebook: create, list and detail work without a review score, also with old skill_reviews rows", () => {
  const { db, member } = setup();
  const r = svc.create(db, member, { name: "plain", description: "d", body: "one line" });
  assert.equal(r.status, 201);
  const s = (r.body as { skill: { id: number; contentHash: string; tenantId: number } }).skill;
  assert.ok(!("review" in (r.body as object)));
  // a row left by the old rulebook build: kept in the DB, ignored by this build
  db.prepare("INSERT INTO skill_reviews (tenant_id, skill_id, content_hash, rules_version, score, results_json, trigger, created_at) VALUES (?, ?, ?, 'v', 42, '[]', 'create', 1)").run(s.tenantId, s.id, s.contentHash);
  const row = (svc.list(db, member).body as { skills: Array<Record<string, unknown>> }).skills.find((x) => x.name === "plain")!;
  assert.ok(!("score" in row));
  const d = svc.detail(db, member, s.id);
  assert.equal(d.status, 200);
  assert.ok(!("review" in (d.body as object)));
  assert.ok(!("approval" in (d.body as object)) && !("status" in row), "no approval state anywhere");
});

test("no approvals: any member runs any team skill (manual, real) with no approval rows; old approval rows are kept", async () => {
  const { db, member, member2, lead } = setup();
  const s = createSkill(db, lead, { name: "fresh", description: "d", body: "Do it." });
  db.prepare("INSERT INTO skill_approvals (tenant_id, skill_id, content_hash, approver_id, decision, comment, created_at) VALUES (?, ?, 'old', ?, 'reject', '', 1)").run(s.tenantId, s.id, lead.id);
  for (const u of [member, member2]) {
    const r = svc.run(db, u, s.id, { mode: "real", inputs: { prompt: "x" } }, stubDeps);
    assert.equal(r.status, 202, JSON.stringify(r.body));
  }
  assert.equal((db.prepare("SELECT COUNT(*) n FROM skill_approvals").get() as { n: number }).n, 1, "approval data untouched");
  await new Promise((res) => setTimeout(res, 100));
});
