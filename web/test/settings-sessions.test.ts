// Job 7: Sessions moved from the header menu into Settings > Sessions.
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
    assert.equal(x?.destination, "/settings/sessions");
    assert.equal(x?.permanent, false);
  }
});

test("Sessions is a Settings tab for every user, not in the header menu", () => {
  const tabs = src("components/settings-tabs.tsx");
  const base = tabs.slice(tabs.indexOf("const TABS"), tabs.indexOf("const ADMIN_TABS"));
  assert.match(base, /\["\/settings\/sessions", "Sessions"\]/);
  assert.doesNotMatch(base, /\/settings\/notifications|\/settings\/updates/);
  assert.doesNotMatch(src("components/user-menu.tsx"), /sessions/i);
  assert.ok(existsSync(path.join(__dirname, "../app/settings/sessions/page.tsx")));
  assert.ok(!existsSync(path.join(__dirname, "../app/account/sessions/page.tsx")));
  const page = src("app/settings/sessions/page.tsx");
  assert.match(page, /AuthGate/);
  assert.match(page, /listSessions\(getDb\(\), u\.id, u\.sessionId\)/);
  assert.doesNotMatch(page, /isSystemAdmin/);
});

test("theme toggle (Job 7b): single sun/moon button, no system icon, hydration-safe", () => {
  const t = src("components/theme-toggle.tsx");
  assert.match(t, /title=\{l\.title\} aria-label=\{l\.aria\}/);
  assert.match(t, /dark \? <Sun \/> : <Moon \/>/);
  assert.doesNotMatch(t, /monitor|rect x=|role="radio"|THEMES\.map/);
  assert.match(t, /\(\) => null\)/, "server snapshot is null (placeholder), so no hydration mismatch");
});
