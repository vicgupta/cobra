import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { createAgent, deleteAgent } from "../lib/agents";
import { createTask, deleteTask } from "../lib/tasks";
import { createSkill, deleteSkill, getSkill, SkillError, updateSkill, type Actor } from "../lib/skills/store";
import * as svc from "../lib/skills/service";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: Actor["role"], tenant = "default") => {
    const id = createUser(db, { email, tenant, tenantName: tenant === "default" ? undefined : `Team ${tenant}`, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  return { db, admin: mk("vicgupta@gmail.com", "admin"), lead: mk("lead@x.com", "team_lead"), member: mk("member@x.com", "member"), member2: mk("m2@x.com", "member"), bLead: mk("leadb@other.com", "team_lead", "other"), bAdmin: mk("adminb@other.com", "admin", "other") };
}
const step = (id: string) => ({ id, action: "simulate", with: { v: id }, on_failure: "stop", outputs: { v: "result.v" } });
const mkSkill = (db: ReturnType<typeof setup>["db"], u: Actor, name: string) => createSkill(db, u, { name, description: "d", body: `# ${name}`, plan: { steps: [step("a")] } });
const count = (db: ReturnType<typeof setup>["db"], table: string, id: number) => (db.prepare(`SELECT count(*) n FROM ${table} WHERE skill_id = ?`).get(id) as { n: number }).n;
const err = (status: number, re?: RegExp) => (e: unknown) => e instanceof SkillError && e.status === status && (!re || re.test(e.message));

test("delete works for the creator; versions, audit and child rows are removed; past runs are kept", () => {
  const { db, member } = setup();
  const s = mkSkill(db, member, "tidy");
  updateSkill(db, member, s.id, { body: "# tidy v2" });
  assert.ok(count(db, "skill_versions", s.id) >= 2);
  assert.ok(count(db, "skill_audit", s.id) >= 1);
  db.prepare("INSERT INTO runs (id, tenant_id, agent, repo, issue, title, workflow, status, mode, started_at) VALUES ('r1', ?, 'skill', '', 0, 'tidy', 'skill:tidy', 'succeeded', 'simulated', 1)").run(member.tenantId);
  deleteSkill(db, member, s.id);
  assert.equal(getSkill(db, member, s.id), null);
  for (const t of ["skill_versions", "skill_approvals", "skill_reviews", "skill_review_cycles", "skill_audit"]) assert.equal(count(db, t, s.id), 0, t);
  assert.ok(db.prepare("SELECT 1 FROM runs WHERE id = 'r1'").get(), "past run kept");
  assert.ok(db.prepare("SELECT 1 FROM skill_audit WHERE action = 'delete' AND skill_id IS NULL AND detail LIKE '%tidy%'").get(), "delete is audited");
  // the name is free again
  mkSkill(db, member, "tidy");
});

test("team leads and the system admin of the team can delete; other members are refused (403)", () => {
  const { db, member, member2, lead, admin } = setup();
  const a = mkSkill(db, member, "one"), b = mkSkill(db, member, "two");
  assert.throws(() => deleteSkill(db, member2, a.id), err(403));
  assert.ok(getSkill(db, member, a.id), "still there after refusal");
  deleteSkill(db, lead, a.id);
  deleteSkill(db, admin, b.id);
  assert.equal(svc.remove(db, member2, mkSkill(db, member, "three").id).status, 403);
});

test("another team is refused with 404, system admins of other teams included", () => {
  const { db, member, bLead, bAdmin } = setup();
  const s = mkSkill(db, member, "mine");
  assert.throws(() => deleteSkill(db, bLead, s.id), err(404));
  assert.throws(() => deleteSkill(db, bAdmin, s.id), err(404));
  assert.equal(svc.remove(db, bLead, s.id).status, 404);
  assert.ok(getSkill(db, member, s.id));
});

test("a skill still used by an agent, task or another skill is blocked (409) and names the users", () => {
  const { db, member } = setup();
  const s = mkSkill(db, member, "shared");
  createAgent(db, member, { name: "bot", engine: "codex", skillRef: `sop:${s.id}` });
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review" });
  createTask(db, member, { name: "nightly", agent: "rev", skillRef: `sop:${s.id}` });
  createSkill(db, member, { name: "parent", description: "d", kind: "master", body: "# p", plan: { steps: [{ id: "c", action: "call_skill", skill: "shared", on_failure: "stop" }] } });
  assert.throws(() => deleteSkill(db, member, s.id), err(409, /agent 'bot'.*task 'nightly'.*skill 'parent'/));
  const r = svc.remove(db, member, s.id);
  assert.equal(r.status, 409);
  assert.ok(count(db, "skill_versions", s.id) >= 1, "nothing removed while blocked");
  deleteAgent(db, member, "bot");
  const t = db.prepare("SELECT id FROM tasks WHERE name = 'nightly'").get() as { id: number };
  deleteTask(db, member, t.id);
  db.prepare("DELETE FROM skills WHERE name = 'parent'").run();
  deleteSkill(db, member, s.id);
  assert.equal(getSkill(db, member, s.id), null);
});

test("API route and Skills list wire up delete with a confirmation", () => {
  const route = readFileSync(new URL("../app/api/skills/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /export async function DELETE/);
  const ui = readFileSync(new URL("../components/skills.tsx", import.meta.url), "utf8");
  assert.match(ui, /ConfirmDialog/);
  assert.match(ui, /r\.canEdit && <button className=\{danger\} aria-label=\{`Delete \$\{r\.name\}`\}/);
  assert.match(ui, /"DELETE"/);
});
