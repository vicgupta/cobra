// One-click engineering automation library: catalog, activate (editable), collisions, confirm UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { createAgent } from "../lib/agents";
import { addTeamRepo } from "../lib/repos";
import { getSkill, skillByName, type Actor } from "../lib/skills/store";
import { getTask, listTasks } from "../lib/tasks";
import { activateLibraryPack, LibraryError, libraryPack } from "../lib/automation-library";
import { listTaskTemplates, toLibraryPack } from "../lib/task-templates";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const member = mk("member@a.com", "member", "team-a");
  return { db, member, other: mk("m@b.com", "member", "team-b") };
}

test("catalog has the five engineering packs with ET schedules and suggested delivery", () => {
  const { db } = setup();
  const packs = listTaskTemplates(db).map((t) => toLibraryPack(t));
  assert.deepEqual(packs.map((p) => p.key).sort(), ["ci-digest", "morning-brief", "review-follow-up", "stale-prs", "weekly-health"]);
  assert.equal(libraryPack(db, "morning-brief")!.cron, "0 9 * * 1-5");
  assert.equal(libraryPack(db, "stale-prs")!.cron, "0 10 * * 1-5");
  assert.equal(libraryPack(db, "ci-digest")!.cron, "0 8 * * 1-5");
  assert.equal(libraryPack(db, "review-follow-up")!.cron, "0 11 * * 1-5");
  assert.equal(libraryPack(db, "weekly-health")!.cron, "0 9 * * 1");
  for (const p of packs) {
    assert.equal(p.notifyOn, "both");
    assert.equal(p.notifyInApp, true);
    assert.ok(p.skillBody.includes("## "));
    assert.ok(p.scheduleLabel.includes("ET"));
  }
});

test("activate creates an editable skill + task; repo and agent are required", () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "Review the repo" });
  addTeamRepo(db, member, "vicgupta/cobra");
  assert.throws(() => activateLibraryPack(db, member, { pack: "morning-brief" }), (e: unknown) => e instanceof LibraryError && e.status === 400 && /agent/.test(e.message));
  assert.throws(() => activateLibraryPack(db, member, { pack: "morning-brief", agent: "rev" }), (e: unknown) => e instanceof LibraryError && e.status === 400 && /repo/.test(e.message));
  const r = activateLibraryPack(db, member, {
    pack: "morning-brief", agent: "rev", repo: "vicgupta/cobra",
    skillName: "custom-morning-brief", taskName: "our-morning-brief", skillBody: "# Brief\n\n## Look\nList open PRs.\n\n## Report\nWrite a short brief.",
    notifyOn: "failure", notifyInApp: true, cron: "0 7 * * 1-5", enabled: true, mode: "simulated",
  });
  assert.equal(r.pack, "morning-brief");
  assert.equal(r.skill.name, "custom-morning-brief");
  assert.match(r.skill.body, /List open PRs/);
  assert.equal(r.task.name, "our-morning-brief");
  assert.equal(r.task.agent, "rev");
  assert.equal(r.task.repo, "vicgupta/cobra");
  assert.equal(r.task.cron, "0 7 * * 1-5");
  assert.equal(r.task.enabled, true);
  assert.equal(r.task.skillRef, `sop:${r.skill.id}`);
  assert.equal(r.task.notifyOn, "failure");
  assert.equal(r.task.notifyInApp, true);
  assert.equal(getSkill(db, member, r.skill.id)?.name, "custom-morning-brief");
  assert.equal(getTask(db, member.tenantId, r.task.id)?.name, "our-morning-brief");
});

test("activate is team-scoped; name collision rolls back so no orphan skill", () => {
  const { db, member, other } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "p" });
  addTeamRepo(db, member, "vicgupta/cobra");
  createAgent(db, other, { name: "rev", engine: "codex", prompt: "p" });
  addTeamRepo(db, other, "other/repo");
  const a = activateLibraryPack(db, member, { pack: "weekly-health", agent: "rev", repo: "vicgupta/cobra" });
  assert.equal(listTasks(db, other.tenantId).length, 0);
  assert.equal(skillByName(db, other.tenantId, a.skill.name), null);
  const before = (db.prepare("SELECT count(*) n FROM skills WHERE tenant_id = ?").get(member.tenantId) as { n: number }).n;
  assert.throws(() => activateLibraryPack(db, member, { pack: "weekly-health", agent: "rev", repo: "vicgupta/cobra" }), (e: unknown) => e instanceof LibraryError && e.status === 409);
  assert.equal((db.prepare("SELECT count(*) n FROM skills WHERE tenant_id = ?").get(member.tenantId) as { n: number }).n, before, "failed activate leaves no extra skill");
  // A second pack with a unique name works
  const b = activateLibraryPack(db, member, { pack: "ci-digest", agent: "rev", repo: "vicgupta/cobra" });
  assert.equal(b.task.name, "ci-digest");
});

test("unknown pack is a 400; defaults fill in suggested schedule and delivery", () => {
  const { db, member } = setup();
  createAgent(db, member, { name: "rev", engine: "codex", prompt: "p" });
  addTeamRepo(db, member, "vicgupta/cobra");
  assert.throws(() => activateLibraryPack(db, member, { pack: "workout-plan", agent: "rev", repo: "vicgupta/cobra" }), (e: unknown) => e instanceof LibraryError && e.status === 400);
  const r = activateLibraryPack(db, member, { pack: "stale-prs", agent: "rev", repo: "vicgupta/cobra" });
  assert.equal(r.task.cron, "0 10 * * 1-5");
  assert.equal(r.task.notifyOn, "both");
  assert.equal(r.task.mode, "simulated");
  assert.equal(r.task.enabled, true);
});

test("library UI is a confirm-then-create form, editable, no JSON dumps", () => {
  const src = readFileSync("components/automation-library.tsx", "utf8");
  assert.match(src, /data-automation-library/);
  assert.match(src, /Review and turn on/);
  assert.match(src, /ConfirmDialog/);
  assert.match(src, /Create skill and task/);
  assert.match(src, /skillBody/);
  assert.doesNotMatch(src, /JSON\.stringify/);
  assert.doesNotMatch(src, /<pre/);
  const page = readFileSync("app/tasks/page.tsx", "utf8");
  assert.match(page, /AutomationLibrary/);
  assert.match(page, /tab === "templates"/);
  assert.doesNotMatch(page, /JSON\.stringify/);
});
