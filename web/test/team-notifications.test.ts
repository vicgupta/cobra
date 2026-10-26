// Job 6: team-facing daily email. 7 AM ET per team (DST-correct, one claim per team per day, catch-up
// until noon), recipients 'Team leads' (default) or 'Entire team' minus opt-outs, lead/admin-only edits,
// member self opt-out, test send to the clicking user only, team_audit, and strict tenant isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { maybeSendDaily } from "../lib/notifications";
import * as T from "../lib/team-notifications";

const T7 = Date.UTC(2026, 9, 27, 11, 0); // Tue Oct 27 2026 7:00 AM EDT
const OLD = T7 - 10 * 86_400_000;
const H = () => ({ uptimeSec: 7200, diskFreeBytes: 5e9, diskTotalBytes: 2e10, dbBytes: 3e6 });

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, tenant: string, role: "admin" | "team_lead" | "member", at = OLD) => {
    const id = createUser(db, { email, tenant, tenantName: tenant === "a" ? "Alpha" : "Bravo", role, password: "pw-1234567890" }, at);
    const tenantId = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId };
  };
  const u = {
    admin: mk("vic@a.com", "a", "admin"), leadA: mk("lead@a.com", "a", "team_lead"), lead2A: mk("lead2@a.com", "a", "team_lead"), memA: mk("mem@a.com", "a", "member"),
    leadB: mk("lead@b.com", "b", "team_lead"), memB: mk("mem@b.com", "b", "member"),
  };
  const sent: Array<[string, string, string]> = [];
  const send = async (to: string, s: string, b: string) => { sent.push([to, s, b]); };
  return { db, u, sent, send, mk };
}

/** Team A activity marked SECRET-A so any leak into team B's email is caught. */
function seedTeamA(db: ReturnType<typeof openDb>, a: number, actor: number, now = T7) {
  const at = now - 3_600_000;
  db.prepare("INSERT INTO runs (id, tenant_id, agent, repo, issue, title, started_at, status, engine, error) VALUES ('run-a1', ?, 'x', 'o/r', 0, 'SECRET-A-run', ?, 'failed', 'claude', 'SECRET-A-error'), ('run-a2', ?, 'x', 'o/r', 0, 't', ?, 'succeeded', 'codex', NULL)").run(a, at, a, at);
  db.prepare("INSERT INTO run_usage (run_id, provider, model, input_tokens, output_tokens, cost_usd, created_at) VALUES ('run-a1', 'anthropic', 'SECRET-A-model', 1000, 234, 0.5, ?)").run(at);
  db.prepare("INSERT INTO skills (tenant_id, name, kind, plan_json, content_hash, created_at, updated_at) VALUES (?, 'SECRET-A-skill', 'sop', '{}', 'h', ?, ?)").run(a, at, at);
  db.prepare("INSERT INTO collab_audit (tenant_id, actor_id, actor_email, action, repo, number, at) VALUES (?, ?, 'lead@a.com', 'merge', 'o/SECRET-A-repo', 7, ?)").run(a, actor, at);
  db.prepare("INSERT INTO team_audit (tenant_id, actor_email, action, target_email, detail, at) VALUES (?, 'lead@a.com', 'invite_create', 'SECRET-A-invitee@x.com', '', ?)").run(a, at);
  db.prepare("INSERT INTO join_requests (tenant_id, email, status, created_at, expires_at) VALUES (?, 'j@x.com', 'pending', ?, ?)").run(a, at, now + 86_400_000);
  db.prepare("INSERT INTO team_invites (tenant_id, email, role, token_hash, created_by_email, created_at, expires_at, used_at) VALUES (?, 'i1@x.com', 'member', 'h1', 'lead@a.com', ?, ?, ?), (?, 'i2@x.com', 'member', 'h2', 'lead@a.com', ?, ?, NULL)").run(a, at, now + 86_400_000, at, a, at, now + 86_400_000);
}

test("daily: 7 AM ET (DST-correct), one per team per day, defaults ON with Team leads, catch-up until noon", async () => {
  const { db, u, sent, send } = setup();
  assert.equal(await T.maybeSendTeamDaily(db, send, T7 - 60_000), "not-due");
  const r = await T.maybeSendTeamDaily(db, send, T7) as Record<number, string>;
  assert.deepEqual(r, { [u.leadA.tenantId]: "sent", [u.leadB.tenantId]: "sent" });
  assert.deepEqual(sent.filter((s) => /Alpha/.test(s[1])).map((s) => s[0]).sort(), ["lead2@a.com", "lead@a.com"], "default = team leads only");
  assert.deepEqual(sent.filter((s) => /Bravo/.test(s[1])).map((s) => s[0]), ["lead@b.com"]);
  assert.deepEqual(await T.maybeSendTeamDaily(db, send, T7 + 60_000), {}, "already claimed");
  const [x, y] = await Promise.all([T.maybeSendTeamDaily(db, send, T7 + 86_400_000), T.maybeSendTeamDaily(db, send, T7 + 86_400_000)]);
  assert.equal(sent.length, 6, "concurrent ticks still send once per team");
  assert.ok(x && y);
  // winter: 7 AM EST = 12:00 UTC; noon cut-off
  assert.equal(await T.maybeSendTeamDaily(db, send, Date.UTC(2026, 11, 1, 11, 59)), "not-due");
  assert.equal(await T.maybeSendTeamDaily(db, send, Date.UTC(2026, 11, 1, 17, 0)), "not-due", "noon ET: too late");
  const c = await T.maybeSendTeamDaily(db, send, Date.UTC(2026, 11, 2, 16, 30)) as Record<number, string>; // 11:30 AM EST catch-up
  assert.equal(c[u.leadA.tenantId], "sent");
});

test("recipients: 'Entire team' choice, designated lead, opt-out; disabled and empty skip with a reason", async () => {
  const { db, u, sent, send } = setup();
  const A = { ...u.leadA };
  assert.equal(T.teamNotifyStatus(db, A).modeLabel, "Team leads");
  T.setTeamNotifyMode(db, A, "all");
  assert.deepEqual(T.resolvedRecipients(db, A.tenantId).sort(), ["lead2@a.com", "lead@a.com", "mem@a.com", "vic@a.com"]);
  T.setMyOptOut(db, u.memA, true);
  assert.deepEqual(T.teamNotifyStatus(db, A).recipients.sort(), ["lead2@a.com", "lead@a.com", "vic@a.com"]);
  // designated lead is included in 'leads' mode (even if they were demoted later, the designation counts)
  T.setTeamNotifyMode(db, A, "leads");
  db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(u.lead2A.id, A.tenantId);
  assert.deepEqual(T.resolvedRecipients(db, A.tenantId).sort(), ["lead2@a.com", "lead@a.com"]);
  // team B: disabled -> skipped
  T.setTeamNotifyEnabled(db, u.leadB, false);
  T.setMyOptOut(db, u.leadA, true); T.setMyOptOut(db, u.lead2A, true);
  const r = await T.maybeSendTeamDaily(db, send, T7) as Record<number, string>;
  assert.equal(r[u.leadB.tenantId], "disabled"); assert.equal(r[A.tenantId], "no-recipients");
  assert.equal(sent.length, 0);
  const s = T.teamNotifyStatus(db, A).lastSend!;
  assert.equal(s.status, "skipped"); assert.match(s.error ?? "", /no recipients \(Team leads/);
  assert.equal(T.teamNotifyStatus(db, u.leadB).lastSend!.error, "disabled");
});

test("permissions: members see but only manage their own opt-out; leads/admins edit; everything audited", async () => {
  const { db, u, sent, send } = setup();
  const forbid = (fn: () => unknown) => assert.throws(fn, (e) => e instanceof CollabError && e.status === 403);
  forbid(() => T.setTeamNotifyEnabled(db, u.memA, false));
  forbid(() => T.setTeamNotifyMode(db, u.memA, "all"));
  await assert.rejects(T.sendTeamTestNow(db, u.memA, send), (e) => e instanceof CollabError && e.status === 403);
  assert.equal(T.teamNotifyStatus(db, u.memA).canEdit, false);
  assert.throws(() => T.setTeamNotifyMode(db, u.leadA, "everyone"), (e) => e instanceof CollabError && e.status === 400);
  T.setMyOptOut(db, u.memA, true); T.setMyOptOut(db, u.memA, false);
  T.setTeamNotifyEnabled(db, u.admin, false); T.setTeamNotifyMode(db, u.leadA, "all");
  await T.sendTeamTestNow(db, u.leadA, send);
  assert.deepEqual(sent.map((s) => s[0]), ["lead@a.com"], "test goes only to the clicking user");
  assert.match(sent[0][1], /^\[Test\]/);
  const acts = (db.prepare("SELECT action, detail FROM team_audit WHERE tenant_id = ? ORDER BY id").all(u.leadA.tenantId) as Array<{ action: string; detail: string }>);
  assert.deepEqual(acts.map((a) => a.action), ["notify_optout", "notify_optin", "notify_toggle", "notify_recipients", "notify_test"]);
  assert.match(acts[3].detail, /Team leads -> Entire team/);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM team_audit WHERE tenant_id = ?").get(u.leadB.tenantId) as { n: number }).n, 0);
});

test("tenant isolation: team B's email and view never include team A's data", async () => {
  const { db, u, sent, send, mk } = setup();
  seedTeamA(db, u.leadA.tenantId, u.leadA.id);
  mk("new@a.com", "a", "member", T7 - 3_600_000);
  const a = T.buildTeamReport(db, u.leadA.tenantId, T7).text, b = T.buildTeamReport(db, u.leadB.tenantId, T7).text;
  for (const s of ["SECRET-A-run", "SECRET-A-error", "SECRET-A-model", "SECRET-A-skill", "SECRET-A-repo", "SECRET-A-invitee", "new@a.com", "run-a1"]) {
    assert.ok(a.includes(s), `team A sees ${s}`);
    assert.ok(!b.includes(s), `team B must not see ${s}`);
  }
  assert.match(a, /RUNS \(2\)/); assert.match(b, /RUNS \(0\)/);
  assert.match(a, /Total tokens: 1,234; reported cost: \$0\.50/); assert.match(b, /Total tokens: 0; reported cost: n\/a/);
  assert.match(a, /Join requests: 1 new, 1 pending/); assert.match(a, /Invites: 2 sent, 1 accepted, 1 pending/);
  assert.match(b, /Join requests: 0 new, 0 pending/);
  assert.match(a, /https:\/\/nova\.kantsy\.com\/runs\/run-a1/);
  for (const t of [a, b]) assert.doesNotMatch(t, /SERVICE HEALTH|uptime|disk|all teams|Rate-limit|sign-ins/i, "no system-wide or admin metrics");
  T.setTeamNotifyMode(db, u.leadB, "all");
  await T.maybeSendTeamDaily(db, send, T7);
  for (const [to, , body] of sent.filter((s) => s[0].endsWith("@b.com"))) { assert.ok(!body.includes("SECRET-A"), `${to} got team A data`); }
  assert.ok(!sent.some((s) => s[0].endsWith("@a.com") && /Bravo/.test(s[1])));
  const vb = T.teamNotifyStatus(db, u.leadB);
  assert.ok(vb.candidates.every((c) => c.email.endsWith("@b.com")) && vb.recent.every((r) => !/@a\.com/.test(r.recipients)));
  assert.ok(T.listTeamNotifyAudit(db, u.leadB.tenantId).every((x) => x.actorEmail.endsWith("@b.com")));
});

test("admin daily email is byte-identical with team notifications running alongside", async () => {
  const run = async (withTeams: boolean) => {
    const { db, u } = setup();
    seedTeamA(db, u.leadA.tenantId, u.leadA.id);
    const sent: Array<[string, string, string]> = [];
    const send = async (to: string, s: string, b: string) => { sent.push([to, s, b]); };
    const teamSent: unknown[] = [];
    if (withTeams) await T.maybeSendTeamDaily(db, async (...x) => { teamSent.push(x); }, T7);
    assert.equal(await maybeSendDaily(db, send, T7 + 1000, H), "sent");
    if (withTeams) assert.ok(teamSent.length > 0);
    return sent;
  };
  const before = await run(false), after = await run(true);
  assert.deepEqual(after, before);
  assert.deepEqual(before.map((s) => s[0]), ["vic@a.com"], "admin email still goes to system admins only");
});
