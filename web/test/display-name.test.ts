// Job 7c: the header shows the display name (or the email's local part), never the full email.
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

test("header user menu never renders the email", () => {
  const s = readFileSync(path.join(__dirname, "../components/user-menu.tsx"), "utf8");
  assert.doesNotMatch(s, /\{u\.email\}/);
  assert.match(s, /displayName\(u\)/);
});
