// Settings > Notifications: one shared digest builder (team scope is a parameter), per-team view for
// every member, lead-only controls, admin-only all-teams section, and strict two-team isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { buildDigest, digestHtml, STUCK_AFTER_MS } from "../lib/digest";
import { buildDailyReport, digestRecipients, notificationStatus } from "../lib/notifications";
import * as T from "../lib/team-notifications";

const NOW = Date.UTC(2026, 9, 27, 11, 0);
const H = { uptimeSec: 3600, diskFreeBytes: 5e9, diskTotalBytes: 2e10, dbBytes: 3e6 };
const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

function seed() {
  const db = openDb(":memory:");
  const mk = (email: string, tenant: string, role: "admin" | "team_lead" | "member") => {
    const id = createUser(db, { email, tenant, tenantName: tenant === "a" ? "Alpha" : "Bravo", role, password: "pw-1234567890" }, NOW - 10 * 86_400_000);
    return { id, email, role, tenantId: (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t };
  };
  const u = { admin: mk("root@a.com", "a", "admin"), leadA: mk("lead@a.com", "a", "team_lead"), memA: mk("mem@a.com", "a", "member"), leadB: mk("lead@b.com", "b", "team_lead"), memB: mk("mem@b.com", "b", "member") };
  const run = db.prepare("INSERT INTO runs (id, tenant_id, agent, repo, issue, title, started_at, status, engine, error) VALUES (?, ?, ?, 'o/r', 0, 't', ?, ?, ?, ?)");
  const use = db.prepare("INSERT INTO run_usage (run_id, provider, model, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const at = NOW - 3_600_000;
  for (const [t, X] of [[u.leadA.tenantId, "A"], [u.leadB.tenantId, "B"]] as const) {
    const k = X === "A" ? 1 : 3;
    for (let i = 0; i < k; i++) run.run(`run-${X}-fail${i}`, t, `agent-${X}`, at, "failed", X === "A" ? "claude" : "codex", `ERR-${X}-msg`);
    run.run(`run-${X}-ok`, t, `agent-${X}`, at, "succeeded", X === "A" ? "claude" : "codex", null);
    run.run(`run-${X}-stuck`, t, `agent-${X}`, NOW - STUCK_AFTER_MS - 60_000, "running", "claude", null);
    use.run(`run-${X}-ok`, X === "A" ? "anthropic" : "openai", `MODEL-${X}`, X === "A" ? 100 : 7000, 0, X === "A" ? 0.25 : 2, at);
  }
  return { db, u };
}

test("shared builder: team scope sees only its team; all scope sees both with per-team breakdowns", () => {
  const { db, u } = seed();
  const a = buildDigest(db, { kind: "team", tenantId: u.leadA.tenantId }, NOW), b = buildDigest(db, { kind: "team", tenantId: u.leadB.tenantId }, NOW);
  const all = buildDigest(db, { kind: "all" }, NOW, { health: H });
  assert.equal(a.runs.total, 3); assert.equal(b.runs.total, 5); assert.equal(all.runs.total, 8);
  assert.deepEqual(a.costs.byModel.map((m) => m.model), ["MODEL-A"]); assert.equal(a.costs.tokens, 100); assert.equal(a.costs.costUsd, 0.25);
  assert.deepEqual(b.costs.byModel.map((m) => m.model), ["MODEL-B"]);
  assert.deepEqual(a.errors.groups.map((g) => ({ ...g })), [{ team: null, engine: "claude", agent: "agent-A", n: 1 }]);
  assert.deepEqual(a.errors.top.map((t) => [t.message, t.n]), [["ERR-A-msg", 1]]); assert.match(a.errors.top[0].lastRunId, /^run-A-/);
  assert.deepEqual(b.errors.top.map((t) => [t.message, t.n]), [["ERR-B-msg", 3]]);
  assert.deepEqual(a.errors.stuck.map((s) => s.id), ["run-A-stuck"]); assert.deepEqual(b.errors.stuck.map((s) => s.id), ["run-B-stuck"]);
  assert.deepEqual(a.runs.byTeam, []); assert.deepEqual(a.costs.byTeam, []); assert.equal(a.extra.health, null);
  assert.deepEqual(all.runs.byTeam.map((t) => t.team).sort(), ["Alpha", "Bravo"]);
  assert.deepEqual(all.costs.byTeam.map((t) => t.team), ["Bravo", "Alpha"]);
  assert.equal(all.errors.stuck.length, 2); assert.ok(all.extra.health);
  const dumpA = JSON.stringify(a) + digestHtml(a, "s") + T.buildTeamReport(db, u.leadA.tenantId, NOW).text;
  for (const leak of ["MODEL-B", "ERR-B", "run-B", "agent-B", "Bravo", "codex", "lead@b.com"]) assert.ok(!dumpA.includes(leak), `team A leaks ${leak}`);
  const dumpB = JSON.stringify(b) + digestHtml(b, "s") + T.buildTeamReport(db, u.leadB.tenantId, NOW).text;
  for (const leak of ["MODEL-A", "ERR-A", "run-A", "agent-A", "Alpha"]) assert.ok(!dumpB.includes(leak), `team B leaks ${leak}`);
});

test("view and test send: a user only ever reaches their own tenant, even with a tampered tenantId", async () => {
  const { db, u } = seed();
  // a forged user object claiming team B's tenant is the only way to reach B: the API always passes the session user
  for (const who of [u.memA, u.leadA]) {
    const tampered = { ...who, tenantIdOverride: u.leadB.tenantId } as typeof who;
    const d = T.teamDigestFor(db, tampered, NOW);
    assert.equal(d.teamName, "Alpha"); assert.ok(!JSON.stringify(d).includes("B-"));
    assert.ok(T.teamNotifyStatus(db, tampered).recipients.every((e) => e.endsWith("@a.com")));
  }
  const sent: Array<[string, string, string, unknown]> = [];
  await T.sendTeamTestNow(db, u.leadA, async (to, s, b, o) => { sent.push([to, s, b, o]); }, NOW);
  assert.deepEqual(sent.map((s) => s[0]), ["lead@a.com"]);
  assert.ok(!sent[0][2].includes("ERR-B") && sent[0][2].includes("ERR-A-msg"));
  assert.deepEqual(sent[0][3], { sender: "digest" });
  const rows = db.prepare("SELECT tenant_id t FROM team_notification_sends").all() as Array<{ t: number }>;
  assert.deepEqual(rows.map((r) => r.t), [u.leadA.tenantId]);
  // the route never reads a tenant from the request
  const route = src("../app/api/team-notifications/route.ts");
  assert.doesNotMatch(route, /tenantId\s*[:=]|searchParams|b\??\.tenant|params/);
  assert.match(route, /teamDigestFor\(db, g\.user\)/); assert.match(route, /teamNotifyStatus\(db, g\.user\)/);
  assert.match(route, /sendTeamTestNow\(db, g\.user, sendEmail\)/); assert.match(route, /canEditTeamNotify\(db, g\.user\)\) return NextResponse\.json\([^)]*\{ status: 403 \}/);
});

test("team daily emails: each team's recipients get only their own team's numbers, from the digest sender", async () => {
  const { db, u } = seed();
  db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(u.memB.id, u.memB.tenantId);
  const sent: Array<[string, string, string, unknown]> = [];
  await T.maybeSendTeamDaily(db, async (to, s, b, o) => { sent.push([to, s, b, o]); }, NOW);
  assert.deepEqual(sent.map((s) => s[0]).sort(), ["lead@a.com", "mem@b.com"], "designated lead (B) else team leads (A)");
  for (const [to, subj, body, o] of sent) {
    const mine = to.endsWith("@a.com") ? "A" : "B", other = mine === "A" ? "B" : "A";
    assert.ok(body.includes(`ERR-${mine}-msg`) && body.includes(`MODEL-${mine}`) && body.includes(`run-${mine}-stuck`), to);
    assert.ok(!body.includes(`-${other}-`) && !body.includes(`MODEL-${other}`), `${to} got team ${other} data`);
    assert.match(subj, mine === "A" ? /Alpha/ : /Bravo/);
    assert.deepEqual(o, { sender: "digest" });
  }
});

test("admin digest: COBRA_ADMIN_EMAIL recipient (else admins), unscrubbed for the admin, all-teams content", () => {
  const { db } = seed();
  assert.deepEqual(digestRecipients(db, "boss@kantsy.com"), ["boss@kantsy.com"]);
  assert.deepEqual(digestRecipients(db, ""), ["root@a.com"]);
  assert.deepEqual(notificationStatus(db, "boss@kantsy.com").recipients, ["boss@kantsy.com"], "shown unscrubbed to the admin");
  const r = buildDailyReport(db, NOW, H);
  for (const s of ["Alpha", "Bravo", "MODEL-A", "MODEL-B", "ERR-A-msg", "ERR-B-msg", "run-A-stuck", "run-B-stuck"]) assert.ok(r.text.includes(s), s);
  assert.match(r.subject, /all teams/);
});

test("page and APIs: team view for every member, controls only when canEdit, admin section only for system admins", () => {
  const page = src("../app/settings/notifications/page.tsx");
  assert.match(page, /const admin = isSystemAdmin\(u\);/); assert.match(page, /\{admin && <AdminSection \/>\}/); assert.equal((page.match(/<AdminSection/g) ?? []).length, 1);
  assert.match(page, /t\.canEdit\s*\?\s*<NotifyToggleForm/); assert.equal((page.match(/<NotifyToggleForm scope="team"/g) ?? []).length, 1);
  assert.match(page, /teamDigestFor\(db, u\)/);
  assert.doesNotMatch(page, /notFound\(\)/, "members are not 404'd");
  const admin = src("../app/api/notifications/route.ts");
  assert.match(admin, /status: 403/); assert.equal((admin.match(/if \(!isSystemAdmin\(g\.user\)\) return forbidden\(\);/g) ?? []).length, 2, "GET and POST are admin-only");
  const { db, u } = seed();
  assert.equal(T.canEditTeamNotify(db, u.memA), false); assert.equal(T.canEditTeamNotify(db, u.leadA), true); assert.equal(T.canEditTeamNotify(db, u.admin), true);
});
