// v2: plain-text skills (skills/*.md), run through runDirect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, checkTeamRepo } from "../lib/repos";
import { builtinHandlers } from "../lib/workflows/handlers";
import type { Actor } from "../lib/workflows/store";
import type { RunDeps } from "../lib/workflows/service";
import { buildPrompt, loadTextSkills, parseTextSkill, pickByTrigger, runTextSkill } from "../lib/text-skills";
import path from "node:path";

const dir = path.join(process.cwd(), "skills");

test("text skills: ship.md parses with name, trigger, goal, 4 steps in order, output", () => {
  const s = loadTextSkills(dir);
  assert.deepEqual(s.map((x) => x.id), ["ship"]);
  const ship = s[0];
  assert.equal(ship.name, "Ship");
  assert.equal(ship.trigger, "ship");
  assert.ok(ship.goal && ship.output);
  assert.equal(ship.steps.length, 4);
  assert.deepEqual(ship.steps.map((x) => x.split(":")[0]), ["Create issue", "Middle step", "Create PR", "Merge PR"]);
  assert.ok(!ship.text.startsWith("---"), "no YAML front matter");
});

test("text skills: parse rejects a file missing a trigger", () => {
  assert.throws(() => parseTextSkill("x", "# X\nGoal: g\nSteps:\n1. a\nOutput: o"), /trigger/);
});

test("text skills: trigger picks the right skill, longest match first", () => {
  const a = parseTextSkill("ship", "# Ship\nTrigger: ship\nGoal: g\n1. a\nOutput: o");
  const b = parseTextSkill("ship-docs", "# Docs\nTrigger: ship docs\nGoal: g\n1. a\nOutput: o");
  assert.equal(pickByTrigger([a, b], "Ship docs for the API")?.id, "ship-docs");
  assert.equal(pickByTrigger([a, b], "ship: add a toggle")?.id, "ship");
  assert.equal(pickByTrigger([a, b], "hello"), null);
});

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member") => {
    const id = createUser(db, { email, tenant: "team-a", tenantName: "team-a", role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const admin = mk("admin@a.com", "admin"), member = mk("member@a.com", "member");
  addTeamRepo(db, admin, "vicgupta/factory-demo-app", "main");
  let calls = 0;
  const fetchSpy = (async () => { calls++; throw new Error("no network in tests"); }) as unknown as typeof fetch;
  const deps: RunDeps = { handlers: builtinHandlers({ fetch: fetchSpy, agentRunner: (async () => { calls++; throw new Error("agent runner must not run in simulation"); }) as never, checkRepo: (r) => checkTeamRepo(db, admin.tenantId, r) }), resolveSecret: () => undefined, redact: () => [] };
  return { db, admin, member, deps, calls: () => calls };
}

test("text skills: simulated run goes through the runner and makes zero GitHub calls", async () => {
  const { db, member, deps, calls } = setup();
  const r = runTextSkill(db, member, { prompt: "ship: add a README badge", repo: "vicgupta/factory-demo-app", mode: "simulated" }, deps, loadTextSkills(dir));
  assert.equal(r.status, 201);
  assert.equal((r.body as { skill: string }).skill, "ship");
  const done = await r.run!.done;
  assert.equal(done.status, "succeeded");
  assert.equal(calls(), 0);
  assert.match(String((r.body as { prompt: string }).prompt), /Merging is NOT allowed/);
});

test("text skills: repo policy still applies; admin may merge; prompt required", () => {
  const { db, admin, deps } = setup();
  const sk = loadTextSkills(dir);
  assert.equal(runTextSkill(db, admin, { prompt: "ship x", repo: "someone/else", mode: "simulated" }, deps, sk).status, 400);
  assert.equal(runTextSkill(db, admin, { prompt: "  " }, deps, sk).status, 400);
  assert.match(buildPrompt(sk[0], "t", true), /Merging is allowed/);
});
