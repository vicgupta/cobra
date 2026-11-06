// Settings > Email (migration 37): one kantsy.com mailbox per team, token stored encrypted and never returned,
// lead/designated/admin-only changes with confirm-to-replace and audit, strict team isolation, per-agent opt-in
// (off by default), env injection only when enabled (never argv), launcher allowlist, and redaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { createAgent, getAgent, updateAgent } from "../lib/agents";
import * as E from "../lib/team-email";
import { localRunner } from "../lib/workflows/local-runner";
import { launchEnv } from "../lib/workflows/launcher-client";
import { redact } from "../lib/workflows/engine";

const KEY = "a".repeat(64);
const TOKEN = "f00dfacecafe" + "0123456789abcdef".repeat(3) + "beef";
const TOKEN2 = "0ddba11" + "fedcba9876543210".repeat(3) + "c0ffee1";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, tenant: string, role: "admin" | "team_lead" | "member") => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" }, 1);
    const tenantId = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId };
  };
  return { db, admin: mk("vic@a.com", "a", "admin"), leadA: mk("lead@a.com", "a", "team_lead"), memA: mk("mem@a.com", "a", "member"), leadB: mk("lead@b.com", "b", "team_lead") };
}
const calls: Array<{ url: string; body: string }> = [];
const fakeKantsy = (token: string, status = 201): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
  const body = String(init?.body ?? ""); calls.push({ url: String(url), body });
  const name = JSON.parse(body).name as string;
  return new Response(JSON.stringify(status === 201 ? { email: `${name}@kantsy.com`, token, tier: "free" } : { detail: "Name already taken" }), { status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

test("migration 37: tables and the agent column exist; agents default to no email", () => {
  const { db, leadA } = setup();
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 37);
  const a = createAgent(db, leadA, { name: "mailer", engine: "claude-code", prompt: "hi" });
  assert.equal(a.emailEnabled, false);
  assert.equal(updateAgent(db, leadA, "mailer", { emailEnabled: true }).emailEnabled, true);
  assert.equal(updateAgent(db, leadA, "mailer", { prompt: "changed" }).emailEnabled, true, "kept when not sent");
  assert.throws(() => updateAgent(db, leadA, "mailer", { emailEnabled: "yes" }), /emailEnabled/);
});

test("request: calls kantsy POST /inbox, stores the token encrypted, never returns it; audit", async () => {
  const { db, leadA } = setup();
  const s = await E.requestTeamEmail(db, leadA, { name: "team-a", displayName: "Team A" }, KEY, fakeKantsy(TOKEN));
  assert.equal(calls.at(-1)!.url, "https://api.kantsy.com/inbox");
  assert.deepEqual(JSON.parse(calls.at(-1)!.body), { name: "team-a", display_name: "Team A" });
  assert.equal(s.email?.address, "team-a@kantsy.com");
  assert.ok(!JSON.stringify(s).includes(TOKEN), "status never carries the token");
  assert.ok(!JSON.stringify(E.teamEmailStatus(db, leadA)).includes(TOKEN));
  const raw = db.prepare("SELECT token_enc FROM team_email").get() as { token_enc: string };
  assert.ok(raw.token_enc.startsWith("v1.") && !raw.token_enc.includes(TOKEN), "encrypted at rest");
  assert.deepEqual(E.teamEmailCredentials(db, leadA.tenantId, KEY), { address: "team-a@kantsy.com", token: TOKEN });
  assert.equal(E.teamEmailCredentials(db, leadA.tenantId, "b".repeat(64)), null, "wrong key: no token");
  assert.equal(E.teamEmailAudit(db, leadA.tenantId)[0].action, "create");
  assert.ok(!JSON.stringify(E.teamEmailAudit(db, leadA.tenantId)).includes(TOKEN));
});

test("one per team: replacing needs confirm; kantsy errors surface; bad names rejected before any call", async () => {
  const { db, leadA } = setup();
  await E.requestTeamEmail(db, leadA, { name: "team-a" }, KEY, fakeKantsy(TOKEN));
  await assert.rejects(E.requestTeamEmail(db, leadA, { name: "team-a2" }, KEY, fakeKantsy(TOKEN2)), (e: CollabError) => e.status === 409 && /confirm/.test(e.message));
  await E.requestTeamEmail(db, leadA, { name: "team-a2", replace: true }, KEY, fakeKantsy(TOKEN2));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM team_email").get() as { n: number }).n, 1);
  assert.equal(E.teamEmailCredentials(db, leadA.tenantId, KEY)?.token, TOKEN2);
  assert.equal(E.teamEmailAudit(db, leadA.tenantId)[0].detail, "team-a@kantsy.com -> team-a2@kantsy.com");
  await assert.rejects(E.requestTeamEmail(db, leadA, { name: "taken", replace: true }, KEY, fakeKantsy(TOKEN, 409)), /taken/);
  const n = calls.length;
  for (const name of ["A", "-x", "x", "a_b", "a".repeat(33), "", 5]) await assert.rejects(E.requestTeamEmail(db, leadA, { name, replace: true }, KEY, fakeKantsy(TOKEN)), /name must be/);
  assert.equal(calls.length, n, "no kantsy call for invalid names");
  E.removeTeamEmail(db, leadA);
  assert.equal(E.teamEmailStatus(db, leadA).email, null);
  assert.equal(E.teamEmailAudit(db, leadA.tenantId)[0].action, "remove");
});

test("permissions: members can't change it; other teams never see or use it", async () => {
  const { db, leadA, memA, admin, leadB } = setup();
  await assert.rejects(E.requestTeamEmail(db, memA, { name: "team-a" }, KEY, fakeKantsy(TOKEN)), (e: CollabError) => e.status === 403);
  await E.requestTeamEmail(db, leadA, { name: "team-a" }, KEY, fakeKantsy(TOKEN));
  assert.equal(E.teamEmailStatus(db, memA).canEdit, false);
  assert.equal(E.teamEmailStatus(db, memA).email?.address, "team-a@kantsy.com");
  assert.equal(E.teamEmailStatus(db, admin).canEdit, true);
  assert.throws(() => E.removeTeamEmail(db, memA), (e: CollabError) => e.status === 403);
  assert.equal(E.teamEmailStatus(db, leadB).email, null, "team B sees nothing of team A");
  assert.equal(E.teamEmailCredentials(db, leadB.tenantId, KEY), null);
  assert.deepEqual(E.teamEmailSecrets(db, leadB.tenantId, KEY), []);
  assert.throws(() => E.removeTeamEmail(db, leadB), (e: CollabError) => e.status === 404);
  assert.equal(E.teamEmailStatus(db, leadA).email?.address, "team-a@kantsy.com");
});

function runnerFixture(teamEmail: () => { address: string; token: string } | null) {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-mail-")), out = path.join(tmp, "seen");
  const fake = path.join(tmp, "fake-claude");
  writeFileSync(fake, `#!/bin/sh\necho "MAIL=\${COBRA_TEAM_EMAIL:-none} TOK=\${COBRA_TEAM_EMAIL_TOKEN:+set}" >> ${out}\nfor a in "$@"; do echo "ARG=$a" >> ${out}; done\necho '{"result":"ok"}'\n`);
  chmodSync(fake, 0o755);
  const runner = localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, claudeBin: fake, teamEmail });
  return { runner, seen: () => readFileSync(out, "utf8") };
}
const go = (r: ReturnType<typeof runnerFixture>["runner"], runId: string, w: Record<string, unknown>, log: (s: string) => void = () => {}) =>
  r({ runId, driver: "claude-code", with: { prompt: "do it", ...w }, secrets: {}, signal: new AbortController().signal, log });

test("runner: env only when the run asks for team email; never in argv; note in the prompt", async () => {
  const creds = { address: "team-a@kantsy.com", token: TOKEN };
  const off = runnerFixture(() => creds);
  await go(off.runner, "run_m1", {});
  assert.match(off.seen(), /MAIL=none TOK=\n/);
  assert.ok(!off.seen().includes("kantsy"), "no note without opt-in");
  const on = runnerFixture(() => creds); let log = "";
  await go(on.runner, "run_m2", { team_email: true }, (s) => { log += s; });
  const seen = on.seen();
  assert.match(seen, /MAIL=team-a@kantsy\.com TOK=set/);
  assert.match(seen, /api\.kantsy\.com/, "prompt carries the helper note");
  assert.ok(!seen.includes(TOKEN), "token never in argv");
  assert.ok(!log.includes(TOKEN));
  const truthy = runnerFixture(() => creds);
  await go(truthy.runner, "run_m3", { team_email: "true" });
  assert.match(truthy.seen(), /MAIL=none/, "only a real boolean true opts in");
  const none = runnerFixture(() => null); let l2 = "";
  await go(none.runner, "run_m4", { team_email: true }, (s) => { l2 += s; });
  assert.match(none.seen(), /MAIL=none/); assert.match(l2, /none is set up/);
});

test("launcher allowlist carries the two vars; redaction removes the token", () => {
  assert.deepEqual(launchEnv({ COBRA_TEAM_EMAIL: "x@kantsy.com", COBRA_TEAM_EMAIL_TOKEN: TOKEN }), { COBRA_TEAM_EMAIL: "x@kantsy.com", COBRA_TEAM_EMAIL_TOKEN: TOKEN });
  assert.throws(() => launchEnv({ COBRA_TEAM_EMAIL_X: "x" }), /not allowed/);
  const py = readFileSync(path.join(__dirname, "..", "..", "launcher", "launcher.py"), "utf8");
  assert.match(py, /"COBRA_TEAM_EMAIL", "COBRA_TEAM_EMAIL_TOKEN"/);
  assert.equal(redact(`curl -H "Authorization: Bearer ${TOKEN}"`, [TOKEN]).includes(TOKEN), false);
});

test("agent with emailEnabled marks its workflow step; others don't", () => {
  const { db, leadA } = setup();
  createAgent(db, leadA, { name: "plain", engine: "claude-code", prompt: "hi" });
  createAgent(db, leadA, { name: "mailer", engine: "claude-code", prompt: "hi", emailEnabled: true });
  assert.equal(getAgent(db, leadA.tenantId, "plain")!.emailEnabled, false);
  assert.equal(getAgent(db, leadA.tenantId, "mailer")!.emailEnabled, true);
});
