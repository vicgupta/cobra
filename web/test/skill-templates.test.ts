import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { checkSkill, createSkill, type Actor } from "../lib/skills/store";
import { sections } from "../lib/skills/sections";
import { SKILL_TEMPLATES } from "../lib/skills/templates";

function setup() {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "m@x.com", tenant: "default", role: "member", password: "pw-1234567890" });
  const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
  return { db, u: { id, email: "m@x.com", role: "member", tenantId: t } as Actor };
}

test("templates: 8+ developer starters plus the originals, unique valid lowercase-dash names", () => {
  const keys = SKILL_TEMPLATES.map((t) => t.key);
  for (const k of ["one-line", "implement-review", "fix-bug", "add-feature", "write-tests", "code-review", "refactor", "update-dependencies", "security-audit", "fix-failing-ci"]) assert.ok(keys.includes(k), k);
  assert.ok(SKILL_TEMPLATES.length >= 10);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(SKILL_TEMPLATES.map((t) => t.name)).size, keys.length);
  for (const t of SKILL_TEMPLATES) {
    assert.match(t.name, /^[a-z][a-z0-9-]{0,62}$/, t.name);
    assert.ok(t.label && t.description && t.body.trim(), t.key);
    assert.doesNotMatch(t.body, /cobra/i, `${t.key} is generic`);
  }
});

test("every template validates and saves through the real save path; steps match its ## headings", () => {
  const { db, u } = setup();
  for (const t of SKILL_TEMPLATES) {
    const h2 = sections(t.body).filter((s) => s.level === 2);
    if (t.key !== "one-line") assert.ok(h2.length >= 2 && h2.length <= 5, `${t.key}: ${h2.length} headings`);
    const c = checkSkill(db, u.tenantId, { name: t.name, description: t.description, body: t.body });
    assert.ok(c.ok, `${t.key}: ${JSON.stringify(c)}`);
    const s = createSkill(db, u, { name: t.name, description: t.description, body: t.body });
    const want = t.key === "one-line" ? 1 : h2.length;
    assert.equal(s.plan.steps.length, want, t.key);
    if (want > 1) assert.deepEqual(s.plan.steps.map((x) => x.name), h2.map((x) => x.title), t.key);
  }
});

test("read-only templates say so in every step", () => {
  for (const k of ["code-review", "security-audit"]) {
    const t = SKILL_TEMPLATES.find((x) => x.key === k)!;
    for (const s of sections(t.body).filter((x) => x.level === 2)) {
      const text = t.body.split("\n").slice(s.start, s.end).join("\n");
      assert.match(text, /Don't change any files\./, `${k} / ${s.title}`);
    }
  }
});

test("editor: one dropdown with Blank, the hint, confirm before overwrite, no JSON", () => {
  const ed = readFileSync("components/skills.tsx", "utf8"), page = readFileSync("app/agents/skills/new/page.tsx", "utf8");
  assert.match(ed, /<select[^>]*data-testid="template"/);
  assert.match(ed, /<option value="">Blank<\/option>/);
  assert.match(ed, /Templates just fill in text — edit anything\. Each heading becomes a step\./);
  assert.match(ed, /window\.confirm\(/);
  assert.doesNotMatch(ed, /JSON\.parse/);
  assert.match(page, /SKILL_TEMPLATES/);
  assert.match(page, /kind: "master" as const/);
});
