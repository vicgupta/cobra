// Admin digest "what changed" sections: versions, deploys, usage, errors, admin audit, health; secrets masked;
// "no changes" lines when empty; team digest unchanged; one-off send hour for a single date.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { buildDailyReport, maybeSendDaily, type SysFn } from "../lib/notifications";
import { buildDigest, digestText } from "../lib/digest";
import { lastReportedCommit, maskSecrets } from "../lib/admin-changes";

const H = () => ({ uptimeSec: 7200, diskFreeBytes: 5e9, diskTotalBytes: 2e10, dbBytes: 3e6 });
const T = Date.UTC(2026, 9, 29, 11, 0); // Oct 29 2026 7:00 EDT
const sys = (commit: string): SysFn => (h) => ({ nodeVersion: "v22.1.0", appCommit: commit, commitSubjects: () => ["abc1234 Add thing", "def5678 Fix other"], processUptimeSec: 3600, backups: [{ name: "cobra.db.bak-a", mtime: T - 5000 }, { name: "cobra.db.bak-b", mtime: T - 1000 }], diskFreeBytes: h.diskFreeBytes, diskTotalBytes: h.diskTotalBytes, dbBytes: h.dbBytes, hostUptimeSec: 999999 });
function setup() {
  const db = openDb(":memory:");
  createUser(db, { email: "vic@a.com", tenant: "a", tenantName: "Alpha", role: "admin", password: "pw-1234567890" });
  return db;
}

test("empty day: every section present with 'no changes' lines", () => {
  const db = setup();
  const t = buildDailyReport(db, T, H(), false, sys("1111111aaaa")).text;
  for (const s of ["SOFTWARE VERSIONS", "COBRA DEPLOYS", "USAGE & ANALYTICS", "ERRORS \\(last 24 h\\)", "ADMIN CHANGES", "SYSTEM HEALTH"]) assert.match(t, new RegExp(s));
  assert.match(t, /No version changes/); assert.match(t, /No failed runs/); assert.match(t, /No email send failures/); assert.match(t, /No update failures/);
  assert.match(t, /Node: v22\.1\.0/); assert.match(t, /Cobra app commit: 1111111a/);
  assert.match(t, /DB backups: 2 file\(s\); newest: cobra\.db\.bak-b/);
});

test("versions, failures, deploy diff, usage and audit lines; secret values masked", async () => {
  const db = setup();
  const run = Number(db.prepare("INSERT INTO update_runs (kind, run_date, status, created_at, started_at) VALUES ('scheduled', '2026-10-29', 'partial', ?, ?)").run(T - 3e6, T - 3e6).lastInsertRowid);
  const it = db.prepare("INSERT INTO update_items (run_id, tool, label, kind, before, after, result, method, detail, at) VALUES (?, ?, ?, 'cli', ?, ?, ?, 'npm', ?, ?)");
  it.run(run, "claude-code", "Claude Code CLI", "2.0.1", "2.0.5", "changed", "--version ok", T - 3e6);
  it.run(run, "codex", "Codex CLI", "0.50.0", "0.50.0", "failed", "boom", T - 3e6);
  db.prepare("INSERT INTO runs (id, tenant_id, agent, repo, issue, title, simulated, started_at, status, engine, error) VALUES ('r1', 1, 'dev', 'o/r', 1, 't', 0, ?, 'failed', 'codex', 'x')").run(T - 1000);
  db.prepare("INSERT INTO run_usage (run_id, provider, input_tokens, output_tokens, cost_usd, created_at) VALUES ('r1', 'codex', 100, 50, 0.25, ?)").run(T - 1000);
  db.prepare("INSERT INTO provider_audit (tenant_id, actor_email, engine, at, detail) VALUES (1, 'vic@a.com', 'cursor', ?, 'CURSOR_API_KEY set sk-abcdefghijklmnopqrstuvwxyz0123456789')").run(T - 1000);
  db.prepare("INSERT INTO notification_sends (kind, send_date, status, recipients, error, at) VALUES ('test', '2026-10-28', 'failed', 'vic@a.com', 'smtp down', ?)").run(T - 1000);
  db.prepare("UPDATE notification_settings SET last_commit = '0000000bbbb' WHERE id = 1").run();
  const t = buildDailyReport(db, T, H(), false, sys("1111111aaaa")).text;
  assert.match(t, /Claude Code CLI: 2\.0\.1 -> 2\.0\.5 \[changed\] via npm/);
  assert.match(t, /!! FAILED: Codex CLI: 0\.50\.0 -> 0\.50\.0 \[failed\]/);
  assert.match(t, /Claude Code: 2\.0\.5/);
  assert.match(t, /Deployed: 0000000b -> 1111111a/); assert.match(t, /- abc1234 Add thing/);
  assert.match(t, /Alpha \/ codex \/ failed: 1/); assert.match(t, /Tokens: 150 .*cost \$0\.25/);
  assert.match(t, /Sign-ups \(new users\): \d+; new teams: \d+/);
  assert.match(t, /global|Alpha \/ cursor: CURSOR_API_KEY set \[redacted\]/);
  assert.doesNotMatch(t, /abcdefghijklmnop/);
  assert.match(t, /Admin digest \(test 2026-10-28\) failed: smtp down/);
  // A real daily send records the reported commit.
  assert.equal(await maybeSendDaily(db, async () => {}, T, H, "vic@a.com", sys("1111111aaaa")), "sent");
  assert.equal(lastReportedCommit(db), "1111111aaaa");
  assert.match(buildDailyReport(db, T + 1000, H(), false, sys("1111111aaaa")).text, /No deploys: still 1111111a/);
});

test("team digest has no admin sections", () => {
  const db = setup();
  assert.doesNotMatch(digestText(buildDigest(db, { kind: "team", tenantId: 1 }, T)), /SOFTWARE VERSIONS|SYSTEM HEALTH/);
  assert.equal(maskSecrets("ghp_abcdef123456 ok"), "[redacted] ok");
});

test("one-off date: no 7 AM send, one send at the one-off hour, next day normal 7 AM", async () => {
  const db = setup();
  const sent: string[] = [];
  const send = async (_to: string, s: string) => { sent.push(s); };
  db.prepare("UPDATE notification_settings SET oneoff_date = '2026-10-29', oneoff_hour = 8 WHERE id = 1").run();
  assert.equal(await maybeSendDaily(db, send, T, H, "vic@a.com"), "not-due");
  assert.equal(await maybeSendDaily(db, send, T + 3600_000, H, "vic@a.com"), "sent");
  assert.equal(await maybeSendDaily(db, send, T + 3660_000, H, "vic@a.com"), "already");
  assert.equal(sent.length, 1); assert.doesNotMatch(sent[0], /\[Test\]/);
  const row = db.prepare("SELECT kind, status, triggered_by FROM notification_sends").get() as Record<string, string>;
  assert.deepEqual({ ...row }, { kind: "test", status: "sent", triggered_by: "scheduler (one-off)" });
  assert.equal(await maybeSendDaily(db, send, T + 86_400_000, H, "vic@a.com"), "sent", "next day: normal 7 AM");
  assert.equal(sent.length, 2);
});
