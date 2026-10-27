import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { checkSkill, createSkill, derivePlan, planFromBody, SkillError, updateSkill, type Actor } from "../lib/skills/store";

function setup() {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "m@x.com", tenant: "default", role: "member", password: "pw-1234567890" });
  const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
  return { db, u: { id, email: "m@x.com", role: "member", tenantId: t } as Actor };
}
const REVIEWED = "# Reviewed change\n\n## Implement\nMake the change with tests.\n\n## Review\nCheck correctness, tests and style.\n";
const names = (b: string) => planFromBody(b).steps.map((s) => s.name);

test("steps come from the headings: top title skipped, no/one heading = one step", () => {
  assert.deepEqual(names(REVIEWED), ["Implement", "Review"]);
  assert.deepEqual(planFromBody(REVIEWED).steps.map((s) => s.section), ["implement", "review"]);
  assert.deepEqual(planFromBody(REVIEWED).steps[1].handoffs.at(-1), { from: "steps.implement.outputs.summary", to: "prev" });
  assert.deepEqual(names("# Build it\nx\n# Check it\ny"), ["Build it", "Check it"]);
  assert.deepEqual(planFromBody("Just one line."), derivePlan());
  assert.deepEqual(planFromBody("# Only a title\n\nDo it."), derivePlan());
  assert.deepEqual(names("## A\n```\n## not a heading\n```\n## B"), ["A", "B"]);
  assert.deepEqual(planFromBody("## Same\n## Same\n## 9 lives\n## {{x}}").steps.map((s) => [s.id, s.section]), [["same", "same"], ["same-2", "same-2"], ["step-3", "9-lives"], ["x", "x"]]);
});

test("Vic's bug: Implement + review starter, then own text without those headings, saves", () => {
  const { db, u } = setup();
  const s = createSkill(db, u, { name: "deploy", description: "d", body: "# Deploy checklist\n\nRun the tests, then deploy." });
  assert.equal(s.plan.steps.length, 1);
  const r = createSkill(db, u, { name: "renamed", description: "d", body: "# T\n## Build it\nx\n## Check it\ny" });
  assert.deepEqual(r.plan.steps.map((x) => x.section), ["build-it", "check-it"]);
  assert.deepEqual(createSkill(db, u, { name: "reviewed", description: "d", body: REVIEWED }).plan.steps.map((x) => x.id), ["implement", "review"]);
});

test("live check uses the save rules: ready only when the save would succeed, plain errors", () => {
  const { db, u } = setup();
  assert.deepEqual(checkSkill(db, u.tenantId, { name: "", body: REVIEWED }), { ok: true, steps: ["Implement", "Review"] });
  const empty = checkSkill(db, u.tenantId, { name: "x", body: "" });
  assert.equal(empty.ok, false);
  assert.match((empty as { errors: string[] }).errors[0], /write at least one line/);
  createSkill(db, u, { name: "taken", body: "x" });
  assert.match((checkSkill(db, u.tenantId, { name: "taken", body: "x" }) as { errors: string[] }).errors[0], /already exists/);
  assert.equal(checkSkill(db, u.tenantId, { name: "m", body: "x", kind: "master" }).ok, true);
  // an explicit plan (API) that points at a missing heading gets a plain-words error, no field paths
  const plan = { steps: [{ id: "a", action: "agent", section: "implement", with: { prompt: "p" } }] };
  try { createSkill(db, u, { name: "api", body: "# Other", plan }); assert.fail("should throw"); } catch (e) {
    assert.ok(e instanceof SkillError);
    assert.equal(e.errors[0], "Your steps mention a section called 'Implement', but there's no heading 'Implement' in the text. Add that heading back, or remove the step.");
    assert.doesNotMatch(e.errors.join(), /steps\[/);
  }
});

test("edits: derived steps follow the new headings; a custom plan is kept", () => {
  const { db, u } = setup();
  const s = createSkill(db, u, { name: "flow", body: REVIEWED });
  const e = updateSkill(db, u, s.id, { body: "# T\n## Plan\na\n## Build\nb\n## Ship\nc" }).skill;
  assert.deepEqual(e.plan.steps.map((x) => x.name), ["Plan", "Build", "Ship"]);
  const one = updateSkill(db, u, s.id, { body: "just do it" }).skill;
  assert.equal(one.plan.steps.length, 1);
  const custom = createSkill(db, u, { name: "custom", body: "# A", plan: { steps: [{ id: "z", action: "simulate", with: {} }] } });
  assert.deepEqual(updateSkill(db, u, custom.id, { body: "# B\n# C" }).skill.plan.steps.map((x) => x.id), ["z"]);
});

test("editor and starters carry no hidden plan JSON", () => {
  const ed = readFileSync("components/skills.tsx", "utf8"), page = readFileSync("app/agents/skills/new/page.tsx", "utf8");
  assert.doesNotMatch(ed, /JSON\.parse|setPlan/);
  assert.doesNotMatch(page, /JSON\.stringify|REVIEWED/);
  assert.match(ed, /disabled=\{busy \|\| \(!id && !name\) \|\| \(!!check && !check\.ok\)\}/);
});
