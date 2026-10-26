import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { getUserTheme, setUserTheme } from "../lib/auth/theme-db";
import { toggleLabel, toggleTarget, effectiveTheme, nextTheme, parseTheme, THEME_COOKIE, THEME_INIT_SCRIPT, themeCookieString } from "../lib/theme";

test("theme: parse accepts only light/dark/system", () => {
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("system"), "system");
  for (const v of ["Dark", "", "blue", null, undefined, 1]) assert.equal(parseTheme(v), null);
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("system"), "light");
});

test("theme precedence: signed-in user's saved theme wins over the cookie; default system", () => {
  assert.equal(effectiveTheme(null, null), "system");
  assert.equal(effectiveTheme(null, "dark"), "dark");
  assert.equal(effectiveTheme(undefined, "junk"), "system");
  assert.equal(effectiveTheme("light", "dark"), "light");
  assert.equal(effectiveTheme("system", "dark"), "system");
  assert.equal(effectiveTheme("junk", "light"), "light");
  assert.match(themeCookieString("dark"), new RegExp(`^${THEME_COOKIE}=dark; Path=/;`));
  assert.ok(THEME_INIT_SCRIPT.includes(THEME_COOKIE) && THEME_INIT_SCRIPT.includes("prefers-color-scheme"));
});

test("theme migration 17: adds users.theme (NULL by default, CHECK-constrained), keeps existing users", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, 16);
  const cols = () => (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!cols().includes("theme"));
  const id = createUser(db, { email: "a@example.com", tenant: "default", role: "member", password: "pw-1234567890" });
  migrate(db);
  assert.ok(cols().includes("theme"));
  assert.equal(getUserTheme(db, id), null);
  assert.throws(() => db.prepare("UPDATE users SET theme = 'blue' WHERE id = ?").run(id));
});

test("theme preference API helpers: save, read back, reject invalid, per user", () => {
  const db = openDb(":memory:");
  const a = createUser(db, { email: "a@example.com", tenant: "default", role: "member", password: "pw-1234567890" });
  const b = createUser(db, { email: "b@example.com", tenant: "default", role: "member", password: "pw-1234567890" });
  assert.equal(setUserTheme(db, a, "dark"), "dark");
  assert.equal(getUserTheme(db, a), "dark");
  assert.equal(getUserTheme(db, b), null);
  assert.throws(() => setUserTheme(db, a, "neon"), /light, dark or system/);
  assert.equal(getUserTheme(db, a), "dark");
  setUserTheme(db, a, "system");
  assert.equal(effectiveTheme(getUserTheme(db, a), "light"), "system");
});

test("single toggle: switches to the opposite of the painted theme, never system; labels", () => {
  assert.equal(toggleTarget(true), "light");
  assert.equal(toggleTarget(false), "dark");
  assert.deepEqual(toggleLabel(true), { title: "Light", aria: "Switch to light theme" });
  assert.deepEqual(toggleLabel(false), { title: "Dark", aria: "Switch to dark theme" });
  // no saved choice: system (prefers-color-scheme), resolved before paint
  assert.equal(effectiveTheme(null, null), "system");
  assert.match(THEME_INIT_SCRIPT, /prefers-color-scheme: dark/);
});
