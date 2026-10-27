import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTH_FLOW_PATHS, hasCompletedMembership, isAuthFlowPath, navLinksFor, showUserMenu } from "../lib/nav-gate";

const member = { tenantId: 1, tenantSlug: "acme" };

test("nav-gate: signed-out users get no links and no user menu on any route", () => {
  for (const p of ["/", "/register", "/register/confirm", "/login", "/skills", null]) {
    assert.deepEqual(navLinksFor(null, false, p), []);
    assert.deepEqual(navLinksFor(undefined, true, p), []);
    assert.equal(showUserMenu(null, p), false);
  }
});

test("nav-gate: a session without team membership is treated as mid-registration", () => {
  for (const u of [{ tenantId: 0, tenantSlug: "" }, { tenantId: null, tenantSlug: null }, {}]) {
    assert.equal(hasCompletedMembership(u), false);
    assert.deepEqual(navLinksFor(u, false, "/"), []);
    assert.equal(showUserMenu(u, "/"), false);
  }
});

test("nav-gate: every signup-flow screen hides nav even with a full session", () => {
  for (const p of [...AUTH_FLOW_PATHS, "/register/", "/register/confirm?token=x".split("?")[0], "/reset-password/"]) {
    assert.ok(isAuthFlowPath(p), p);
    assert.deepEqual(navLinksFor(member, true, p), []);
    assert.equal(showUserMenu(member, p), false);
  }
  for (const p of ["/", "/registers", "/skills", "/settings", "/team"]) assert.equal(isAuthFlowPath(p), false, p);
});

test("nav-gate: signed-in members keep the normal menu unchanged (admin gets Admin)", () => {
  assert.deepEqual(navLinksFor(member, false, "/").map((l) => l.label), ["Dashboard", "Agents", "Tasks", "Repos", "Settings"]);
  assert.deepEqual(navLinksFor(member, true, "/skills").map((l) => l.label), ["Dashboard", "Agents", "Tasks", "Repos", "Settings", "Admin"]);
  assert.equal(showUserMenu(member, "/"), true);
  assert.equal(navLinksFor(member, false, null).length, 5);
});

test("nav-gate: wired server-side (layout decides links/menu; proxy forwards pathname)", () => {
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /navLinksFor\(u,/);
  assert.match(layout, /showUserMenu\(u, pathname\)/);
  const nav = readFileSync(new URL("../components/nav.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(nav, /label: "Dashboard"/);
  const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /x-cobra-pathname/);
});
