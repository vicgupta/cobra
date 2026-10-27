// Job 7c/7d: displayName helper; the header shows neither the name nor the email (team only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { displayName } from "../lib/display-name";

test("displayName: name, else email local part", () => {
  assert.equal(displayName({ name: "Vic Gupta", email: "v@example.com" }), "Vic Gupta");
  assert.equal(displayName({ name: "  ", email: "jane.doe@example.com" }), "jane.doe");
  assert.equal(displayName({ name: null, email: "sam@example.com" }), "sam");
});

test("header user menu renders neither the email nor the name (Job 7d) nor the team name; admin badge stays", () => {
  const s = readFileSync(path.join(__dirname, "../components/user-menu.tsx"), "utf8");
  assert.doesNotMatch(s, /\{u\.email\}/);
  assert.doesNotMatch(s, /displayName|u\.name|data-user-name/);
  assert.doesNotMatch(s, /tenantName|data-user-team/);
  assert.match(s, /System admin/);
});

test("header has no 'software factory' tagline (Job 7d); Cobra brand stays", () => {
  const s = readFileSync(path.join(__dirname, "../components/nav.tsx"), "utf8");
  assert.doesNotMatch(s, /software factory/i);
  assert.match(s, /Cobra/);
});
