import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type DB } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { usageCollector, recordUsage, usageReport, parseRange, usageScope } from "../lib/usage";
import { localRunner } from "../lib/workflows/local-runner";
import { gate } from "../lib/admin/gate";

function setup() {
  const db = openDb(":memory:");
  createUser(db, { email: "a@x.com", tenant: "default", role: "admin", password: "pw-1234567890" });
  createUser(db, { email: "b@y.com", tenant: "other", tenantName: "Team other", role: "member", password: "pw-1234567890" });
  const t = (e: string) => (db.prepare("SELECT tenant_id t FROM users WHERE email = ?").get(e) as { t: number }).t;
  return { db, ta: t("a@x.com"), tb: t("b@y.com") };
}
const addRun = (db: DB, id: string, tenant: number, at: number) =>
  db.prepare("INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at, status) VALUES (?, ?, NULL, '', '', 0, 't', '', 0, ?, 'succeeded')").run(id, tenant, at);

test("usage: claude json result gives tokens and reported cost; text logged, JSON not", () => {
  let log = "";
  const c = usageCollector("claude-code", null, (s) => { log += s; });
  c.write('{"type":"result","result":"done!","total_cost_usd":0.125,"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7},"modelUsage":{"claude-x":{}}}');
  const r = c.finish();
  assert.deepEqual(r.usage, { provider: "claude-code", model: "claude-x", input_tokens: 15, output_tokens: 7, cached_tokens: 100, cost_usd: 0.125, cost_source: "reported" });
  assert.equal(r.text, "done!"); assert.equal(log, "done!\n");
});

test("usage: codex jsonl sums turns, never a cost; plain lines pass through; none = null row", () => {
  let log = "";
  const c = usageCollector("codex", "gpt-5", (s) => { log += s; });
  c.write('plain\n{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n{"type":"turn.completed","usage":{"input_tokens":3,"cached_input_tokens":1,"output_tokens":2}}\n');
  c.write('{"type":"turn.completed","usage":{"input_tokens":4,"cached_input_tokens":0,"output_tokens":1}}\n');
  const r = c.finish();
  assert.equal(r.usage!.input_tokens, 7); assert.equal(r.usage!.output_tokens, 3); assert.equal(r.usage!.cached_tokens, 1);
  assert.equal(r.usage!.cost_usd, null); assert.equal(r.usage!.cost_source, null);
  assert.equal(log, "plain\nhi\n");
  const n = usageCollector("cursor", null, () => {});
  n.write("just text\n");
  assert.equal(n.finish().usage, null);
  assert.deepEqual(n.orNull(), { provider: "cursor", model: null, input_tokens: null, output_tokens: null, cached_tokens: null, cost_usd: null, cost_source: null });
});

test("usage: aggregation by run/team/provider, ranges, nulls and no-data runs", () => {
  const { db, ta, tb } = setup();
  const now = 100 * 86_400_000;
  addRun(db, "run_a", ta, now - 1000); addRun(db, "run_b", tb, now - 10 * 86_400_000); addRun(db, "run_old", ta, now - 60 * 86_400_000);
  const u = (p: string, i: number | null, o: number | null, c: number | null) => ({ provider: p, model: null, input_tokens: i, output_tokens: o, cached_tokens: null, cost_usd: c, cost_source: c == null ? null : "reported" as const });
  recordUsage(db, "run_a-plan", u("claude-code", 10, 5, 0.5));
  recordUsage(db, "run_a-build", u("codex", 20, 2, null));
  recordUsage(db, "run_b", u("cursor", null, null, null));
  recordUsage(db, "nope", u("codex", 1, 1, null)); // unknown run: ignored
  assert.deepEqual(db.prepare("SELECT run_id, step_id FROM run_usage ORDER BY id").all().map((r) => ({ ...r })), [{ run_id: "run_a", step_id: "plan" }, { run_id: "run_a", step_id: "build" }, { run_id: "run_b", step_id: null }]);
  const r30 = usageReport(db, "30d", { now });
  assert.equal(r30.totals.input_tokens, 30); assert.equal(r30.totals.cost_usd, 0.5); assert.equal(r30.totals.runs, 2); assert.equal(r30.totals.runs_with_usage, 2);
  assert.deepEqual(r30.runs.map((r) => r.id), ["run_a", "run_b"]);
  assert.equal(r30.runs[1].input_tokens, null); assert.equal(r30.runs[1].cost_usd, null); assert.equal(r30.runs[1].steps, 1);
  assert.deepEqual(r30.teams.map((t) => [t.tenant, t.runs, t.input_tokens]), [["Team other", 1, null], ["Vic", 1, 30]]);
  assert.deepEqual(r30.providers.map((p) => [p.provider, p.input_tokens, p.cost_usd]), [["claude-code", 10, 0.5], ["codex", 20, null], ["cursor", null, null]]);
  assert.equal(usageReport(db, "7d", { now }).runs.length, 1);
  const all = usageReport(db, "all", { now, pageSize: 2 });
  assert.equal(all.pages, 2);
  const p2 = usageReport(db, "all", { now, pageSize: 2, page: 2 });
  assert.deepEqual(p2.runs.map((r) => [r.id, r.steps, r.input_tokens]), [["run_old", 0, null]]); // old run: no data
  assert.equal(parseRange("bogus"), "30d"); assert.equal(parseRange("all"), "all");
});

test("usage: localRunner records usage from fake claude json", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "usage-"));
  const fake = path.join(tmp, "claude");
  writeFileSync(fake, `#!/bin/sh\necho '{"type":"result","result":"ok","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'\n`); chmodSync(fake, 0o755);
  const got: unknown[] = [];
  const run = localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, claudeBin: fake, onUsage: (k, u) => got.push([k, u.input_tokens, u.cost_usd, u.cost_source]) });
  let log = "";
  const res = await run({ runId: "run_z", driver: "claude-code", with: { prompt: "p" }, secrets: {}, signal: new AbortController().signal, log: (s) => { log += s; } });
  assert.deepEqual(got, [["run_z", 1, 0.01, "reported"]]);
  assert.equal(res.summary, "ok"); assert.doesNotMatch(log, /total_cost_usd/);
});

test("usage: admin page is system-admin only (others 404) and never selects secrets", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "usage-gate-"));
  const env = path.join(tmp, "cobra.env"); writeFileSync(env, 'COBRA_ADMIN_EMAIL="a@x.com"\n');
  assert.equal(gate("a@x.com", "admin", env), "ok");
  assert.equal(gate("b@y.com", "admin", env), "not-found");
  assert.equal(gate("lead@x.com", "admin", env), "not-found");
  const page = readFileSync(path.join(__dirname, "../app/admin/page.tsx"), "utf8");
  assert.match(page, /await requireAdmin\(\)/);
  assert.match(page, /\["usage", "Usage"\]/);
  const lib = readFileSync(path.join(__dirname, "../lib/usage.ts"), "utf8");
  assert.doesNotMatch(lib, /sessions|password|_enc|pat_/);
});

test("usage scoping: member/lead see only their team, no cross-team leak; admin sees all", () => {
  const { db, ta, tb } = setup();
  const now = 100 * 86_400_000;
  addRun(db, "run_a1", ta, now - 1000); addRun(db, "run_b1", tb, now - 2000);
  const u = (p: string, i: number, c: number | null) => ({ provider: p, model: "m-" + p, input_tokens: i, output_tokens: 1, cached_tokens: null, cost_usd: c, cost_source: c == null ? null : "reported" as const });
  recordUsage(db, "run_a1", u("claude-code", 100, 1.5));
  recordUsage(db, "run_b1", u("codex", 7, null));
  const member = { role: "member", tenantId: tb }, lead = { role: "team_lead", tenantId: tb }, admin = { role: "admin", tenantId: ta };
  for (const v of [member, lead]) {
    const r = usageReport(db, "all", { now, tenantId: usageScope(v) });
    assert.equal(r.scope, tb);
    assert.deepEqual(r.runs.map((x) => x.id), ["run_b1"]);
    assert.deepEqual(r.teams.map((x) => x.tenant), ["Team other"]);
    assert.deepEqual(r.providers.map((x) => x.provider), ["codex"]);
    assert.equal(r.totals.input_tokens, 7); assert.equal(r.totals.cost_usd, null); assert.equal(r.totals.runs, 1);
    assert.doesNotMatch(JSON.stringify(r), /run_a1|claude-code|1\.5/);
  }
  const all = usageReport(db, "all", { now, tenantId: usageScope(admin) });
  assert.equal(all.scope, null);
  assert.deepEqual(all.runs.map((x) => x.id), ["run_a1", "run_b1"]);
  assert.equal(all.teams.length, 2); assert.equal(all.totals.input_tokens, 107); assert.equal(all.totals.cost_usd, 1.5);
  // the Settings page takes the scope from the session only, never from query params
  const page = readFileSync(path.join(__dirname, "../app/settings/usage/page.tsx"), "utf8");
  assert.match(page, /tenantId=\{scope\}/); assert.doesNotMatch(page, /sp\.(team|tenant)/);
  assert.match(readFileSync(path.join(__dirname, "../components/settings-tabs.tsx"), "utf8"), /\/settings\/usage/);
});
