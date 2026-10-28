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

test("header role indicator: lead/member icon (svg), tooltip text, no visible text, no team name", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { RoleIcon } = await import("../components/role-icon");
  for (const [role, label, icon] of [["team_lead", "Team lead", "team-lead"], ["member", "Team member", "team-member"]] as const) {
    const html = renderToStaticMarkup(React.createElement(RoleIcon, { role }));
    const ind = html.match(/<span data-user-role="[^"]+"[^>]*>([\s\S]*?<\/svg>)<\/span>/);
    assert.ok(ind, `indicator for ${role}`);
    assert.match(ind[0], new RegExp(`aria-label="${label}"`));
    assert.match(ind[1], new RegExp(`<svg[^>]*data-icon="${icon}"`));
    assert.equal(ind[1].replace(/<[^>]+>/g, "").trim(), "", "indicator has no visible text");
    assert.match(html, new RegExp(`<span role="tooltip"[^>]*class="[^"]*invisible[^"]*group-hover:visible[^"]*"[^>]*>${label}</span>`));
  }
  const lead = renderToStaticMarkup(React.createElement(RoleIcon, { role: "team_lead" }));
  assert.doesNotMatch(lead, /team-member|Team member/);
  const s = readFileSync(path.join(__dirname, "../components/user-menu.tsx"), "utf8");
  assert.match(s, /<RoleIcon role=\{u\.role\}/);
  assert.doesNotMatch(s, /tenantName/);
});
