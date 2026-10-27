// System-admin daily analytics email: DST-correct 7 AM ET, one send per day (DB-claimed), admin-only
// settings and test send (to the signed-in admin only), audit, report contents. Mock mail only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { buildDailyReport, listNotificationAudit, maybeSendDaily, notificationStatus, nyClock, sendTestNow, setDailyEnabled } from "../lib/notifications";

const H = () => ({ uptimeSec: 7200, diskFreeBytes: 5e9, diskTotalBytes: 2e10, dbBytes: 3e6 });
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, tenant: string, role: "admin" | "team_lead" | "member") => ({ id: createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" }), email, role });
  const sent: Array<[string, string, string]> = [];
  const send = async (to: string, s: string, b: string) => { sent.push([to, s, b]); };
  return { db, admin: mk("vic@a.com", "a", "admin"), admin2: mk("ops@a.com", "a", "admin"), lead: mk("lead@a.com", "a", "team_lead"), sent, send };
}

test("nyClock is DST-correct: 7 AM ET is 11:00 UTC in summer and 12:00 UTC in winter", () => {
  assert.deepEqual(nyClock(Date.UTC(2026, 6, 1, 11, 0)), { date: "2026-07-01", hour: 7, minute: 0 });
  assert.deepEqual(nyClock(Date.UTC(2026, 11, 1, 12, 0)), { date: "2026-12-01", hour: 7, minute: 0 });
  assert.equal(nyClock(Date.UTC(2026, 11, 1, 11, 59)).hour, 6);
  assert.equal(nyClock(Date.UTC(2026, 10, 1, 11, 0)).hour, 6, "Nov 1 2026: EST already");
});

test("daily send: not before 7, once per NY date to every admin, catch-up until noon, disabled skips", async () => {
  const { db, sent, send } = setup();
  const t7 = Date.UTC(2026, 9, 27, 11, 0); // Oct 27 2026 7:00 EDT
  assert.equal(await maybeSendDaily(db, send, t7 - 60_000, H, ""), "not-due");
  assert.equal(await maybeSendDaily(db, send, t7, H, ""), "sent");
  assert.deepEqual(sent.map((s) => s[0]).sort(), ["ops@a.com", "vic@a.com"], "no COBRA_ADMIN_EMAIL: every admin");
  assert.match(sent[0][1], /Cobra daily digest 2026-10-27 \(all teams\)/);
  assert.equal(await maybeSendDaily(db, send, t7 + 60_000, H, ""), "already");
  const [a, b] = await Promise.all([maybeSendDaily(db, send, Date.UTC(2026, 9, 28, 11, 1), H, ""), maybeSendDaily(db, send, Date.UTC(2026, 9, 28, 11, 1), H, "")]);
  assert.deepEqual([a, b].sort(), ["already", "sent"], "concurrent ticks: one send");
  assert.equal(sent.length, 4);
  assert.equal(await maybeSendDaily(db, send, Date.UTC(2026, 9, 29, 17, 0), H, ""), "not-due", "1 PM ET: too late for catch-up");
  assert.equal(await maybeSendDaily(db, send, Date.UTC(2026, 9, 30, 15, 30), H, ""), "sent", "11:30 AM ET catch-up");
  const { admin } = { admin: { id: 1, email: "vic@a.com", role: "admin" } };
  setDailyEnabled(db, admin, false);
  assert.equal(await maybeSendDaily(db, send, Date.UTC(2026, 9, 31, 11, 0), H), "disabled");
  assert.equal(sent.length, 6);
  assert.equal(notificationStatus(db).lastSend!.status, "skipped");
});

test("failed mail is recorded, not retried the same day", async () => {
  const { db } = setup();
  const bad = async () => { throw new Error("Email send failed: HTTP 500"); };
  assert.equal(await maybeSendDaily(db, bad, Date.UTC(2026, 9, 27, 11, 0), H), "failed");
  assert.match(notificationStatus(db).lastSend!.error!, /HTTP 500/);
  assert.equal(await maybeSendDaily(db, bad, Date.UTC(2026, 9, 27, 11, 5), H), "already");
});

test("settings and test send: system admins only, test goes to the caller only, audited", async () => {
  const { db, admin, lead, sent, send } = setup();
  assert.throws(() => setDailyEnabled(db, lead, false), (e) => e instanceof CollabError && e.status === 403);
  await assert.rejects(sendTestNow(db, lead, send, Date.now(), H), (e) => e instanceof CollabError && e.status === 403);
  assert.throws(() => setDailyEnabled(db, admin, "no"), (e) => e instanceof CollabError && e.status === 400);
  assert.equal(notificationStatus(db).dailyEnabled, true, "default ON");
  const v = await sendTestNow(db, admin, send, Date.now(), H, "boss@kantsy.com");
  assert.deepEqual(sent.map((s) => s[0]), ["boss@kantsy.com"], "test goes to the digest recipient (COBRA_ADMIN_EMAIL)"); assert.match(sent[0][1], /^\[Test\]/);
  assert.equal(v.lastSend!.kind, "test"); assert.equal(v.lastSend!.status, "sent");
  setDailyEnabled(db, admin, false);
  assert.deepEqual(listNotificationAudit(db).map((a) => a.action), ["daily_toggle", "test_send"]);
  assert.equal(notificationStatus(db).updatedBy, "vic@a.com");
});

test("report: runs by status/team/engine, failure links, tokens and null cost, health", () => {
  const { db } = setup();
  const now = Date.UTC(2026, 9, 27, 11, 0);
  const t = (db.prepare("SELECT id FROM tenants LIMIT 1").get() as { id: number }).id;
  const ins = db.prepare("INSERT INTO runs (id, tenant_id, agent, repo, issue, title, started_at, status, engine, error, simulated) VALUES (?, ?, 'a', 'o/r', 0, ?, ?, ?, ?, ?, 0)");
  ins.run("r-ok", t, "ok run", now - 3600_000, "succeeded", "opencode", null);
  ins.run("r-bad", t, "bad run", now - 7200_000, "failed", "codex", "boom");
  ins.run("r-old", t, "old", now - 3 * 86400_000, "failed", "codex", "old");
  db.prepare("INSERT INTO run_usage (run_id, provider, model, input_tokens, output_tokens, cost_usd, created_at) VALUES ('r-ok', 'opencode', 'opencode/gpt-6-sol', 100, 50, NULL, ?)").run(now - 3600_000);
  const r = buildDailyReport(db, now, H());
  assert.equal(r.counts.runs, 2); assert.equal(r.counts.failed, 1); assert.equal(r.counts.tokens, 150); assert.equal(r.counts.costUsd, null);
  assert.match(r.text, /https:\/\/nova\.kantsy\.com\/runs\/r-bad/); assert.ok(!r.text.includes("r-old"));
  assert.match(r.text, /tokens, n\/a/); assert.match(r.text, /disk free 5\.0 GB/); assert.match(r.text, /DB 3\.0 MB/);
  assert.doesNotMatch(r.text, /WORKFLOW|awaiting approval|AUDIT/i, "workflow section and dead audit sources dropped");
});
