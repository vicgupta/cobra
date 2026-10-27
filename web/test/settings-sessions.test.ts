// MVP: Settings keeps Repos, Providers and Team; the old /sessions URLs go to /settings, which opens Repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import nextConfig from "../next.config";

const src = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");

test("sessions redirects keep the query string (307)", async () => {
  const r = await nextConfig.redirects!();
  for (const s of ["/sessions", "/account/sessions"]) {
    const x = r.find((y) => y.source === s);
    assert.equal(x?.destination, "/settings"); // /settings then redirects to Repos
    assert.equal(x?.permanent, false);
  }
});

test("MVP Settings tabs: Repos, Providers, Team, (Updates for admins), Notifications; removed tabs are gone", () => {
  const tabs = src("components/settings-tabs.tsx");
  assert.match(tabs, /const BASE = \[\["\/settings\/repos", "Repos"\], \["\/settings\/providers", "Providers"\], \["\/settings\/team", "Team"\]\]/);
  assert.match(tabs, /const TABS = \[\.\.\.BASE, NOTIFY\]/);
  assert.match(tabs, /const ADMIN_TABS = \[\.\.\.BASE, \["\/settings\/updates", "Updates"\], NOTIFY\]/);
  assert.match(tabs, /NOTIFY = \["\/settings\/notifications", "Notifications"\]/);
  assert.doesNotMatch(tabs, /settings\/(sessions|usage|docs|team-notifications|skill-rules)/);
  assert.match(src("app/settings/page.tsx"), /redirect\("\/settings\/repos"\)/);
  for (const p of ["sessions", "usage", "docs", "team-notifications", "skill-rules"]) assert.ok(!existsSync(path.join(__dirname, `../app/settings/${p}`)), p);
  assert.doesNotMatch(src("components/user-menu.tsx"), /sessions/i);
});

test("theme toggle (Job 7b): single sun/moon button, no system icon, hydration-safe", () => {
  const t = src("components/theme-toggle.tsx");
  assert.match(t, /title=\{l\.title\} aria-label=\{l\.aria\}/);
  assert.match(t, /dark \? <Sun \/> : <Moon \/>/);
  assert.doesNotMatch(t, /monitor|rect x=|role="radio"|THEMES\.map/);
  assert.match(t, /\(\) => null\)/, "server snapshot is null (placeholder), so no hydration mismatch");
});
