// Global display rule: system admins (role admin, or the COBRA_ADMIN_EMAIL user) never appear in member lists/counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { teamLeads } from "../lib/collab";
import { displayTeamMembers, teamMembers } from "../lib/team";
import { currentAdminEmail, visibleMembers } from "../lib/members";

test("system admins hidden from displayed member lists in two tenants; data and roles unchanged", () => {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
  mk("root@a.com", "admin", "team-a"); mk("lead@a.com", "team_lead", "team-a"); mk("m@a.com", "member", "team-a");
  mk("boss@b.com", "team_lead", "team-b"); mk("lead@b.com", "team_lead", "team-b"); mk("m@b.com", "member", "team-b"); mk("admin@b.com", "admin", "team-b");
  const t = (e: string) => (db.prepare("SELECT tenant_id t FROM users WHERE email = ?").get(e) as { t: number }).t;
  const A = t("root@a.com"), B = t("m@b.com");
  const dir = mkdtempSync(path.join(tmpdir(), "hide-adm-")), env = path.join(dir, "cobra.env");
  writeFileSync(env, 'COBRA_ADMIN_EMAIL="Boss@B.com"\n');
  const adm = currentAdminEmail(env);
  assert.deepEqual(displayTeamMembers(db, A, adm).map((m) => m.email), ["lead@a.com", "m@a.com"]);
  assert.deepEqual(displayTeamMembers(db, B, adm).map((m) => m.email), ["lead@b.com", "m@b.com"]); // role admin + COBRA_ADMIN_EMAIL lead both hidden
  assert.equal(displayTeamMembers(db, B, adm).length, 2);
  assert.deepEqual(visibleMembers(teamLeads(db, B), adm).map((l) => l.email), ["lead@b.com"]);
  // underlying data, roles and permission lookups unchanged
  assert.equal(teamMembers(db, A).length, 3); assert.equal(teamMembers(db, B).length, 4);
  assert.equal(teamLeads(db, B).length, 2);
  assert.equal(currentAdminEmail(path.join(dir, "missing.env")), "");
  for (const f of ["../components/team.tsx", "../app/api/team/route.ts"]) assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /displayTeamMembers/, f);
  assert.match(readFileSync(new URL("../lib/team-notifications.ts", import.meta.url), "utf8"), /candidates: visibleMembers\(c\)/);
});

test("admin metrics hide system admins (lists, counts, run emails); send-history recipients scrubbed for display", async () => {
  const m = await import("../lib/admin/metrics");
  const { createSession } = await import("../lib/auth/sessions");
  const { scrubRecipients, visibleRecipients } = await import("../lib/members");
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
  const root = mk("root@a.com", "admin", "team-a"), lead = mk("lead@a.com", "team_lead", "team-a");
  const boss = mk("boss@b.com", "team_lead", "team-b"); mk("m@b.com", "member", "team-b");
  const now = Date.now(); createSession(db, root, now); createSession(db, boss, now); createSession(db, lead, now);
  const adm = "boss@b.com";
  const o = m.overview(db, now, adm);
  assert.equal(o.users, 2); assert.equal(o.activeSessions, 1); assert.equal(o.activeUsers24h, 1);
  assert.deepEqual(o.usersByRole.map((r) => [r.role, r.c]), [["member", 1], ["team_lead", 1]]);
  assert.deepEqual(m.tenants(db, adm).map((t) => [t.slug, t.users, "admins" in t]), [["team-a", 1, false], ["team-b", 1, false]]);
  assert.deepEqual(m.users(db, now, adm).map((u) => u.email), ["lead@a.com", "m@b.com"]);
  assert.deepEqual(m.sessions(db, now, adm).map((s) => s.email), ["lead@a.com"]);
  assert.equal((db.prepare("SELECT count(*) c FROM users").get() as { c: number }).c, 4, "data unchanged");
  // recipients text
  const hid = (e: string) => ["root@a.com", "boss@b.com"].includes(e.toLowerCase());
  assert.equal(scrubRecipients("root@a.com, lead@a.com", hid), "lead@a.com");
  assert.equal(scrubRecipients("ROOT@a.com", hid), "[redacted]");
  assert.equal(scrubRecipients("", hid), "");
  assert.equal(scrubRecipients("[redacted]", hid), "[redacted]");
  assert.equal(visibleRecipients(db, "root@a.com, boss@b.com, m@b.com", adm), "m@b.com");
  const p = readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
  assert.ok(!p.includes('"Admins"') && !p.includes("t.admins"));
});
