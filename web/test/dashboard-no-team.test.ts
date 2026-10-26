import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("dashboard: Team members card is removed; team functionality elsewhere is kept", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /title="Team"/);
  assert.doesNotMatch(page, /Members of/);
  assert.doesNotMatch(page, /FROM users WHERE tenant_id/);
  assert.match(page, /title="Recent runs"/);
  assert.ok(existsSync(new URL("../app/team/page.tsx", import.meta.url)));
  assert.ok(existsSync(new URL("../lib/team.ts", import.meta.url)));
});
