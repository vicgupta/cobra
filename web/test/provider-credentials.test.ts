// Settings > Providers credential manager, per team (Job 11): slots, masked status, team-member set/replace/delete
// with per-team audit, cross-team isolation, env fallback for team 1 only, auth method per provider, runner selection by method, custom OpenAI-compatible providers on OpenCode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { migrate } from "../lib/db";
import { DatabaseSync } from "node:sqlite";

import { listProviderAudit } from "../lib/providers";
import {
  credentialViews, getAuthMode,
  runAuth, canManageProviders, resolveCredential, setAuthMode, setCredential, storedCredential, builtinCredentialSecrets,
} from "../lib/provider-credentials";
import { localRunner } from "../lib/workflows/local-runner";

const SK = Buffer.alloc(32, 7).toString("base64");
const noEnv = () => undefined;
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant = "a") => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    return { id, email, role, tenantId: (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t };
  };
  const r = { db, admin: mk("admin@a.com", "admin"), lead: mk("lead@a.com", "team_lead"), member: mk("m@a.com", "member"), other: mk("o@b.com", "member", "b"), otherLead: mk("ol@b.com", "team_lead", "b") };
  assert.equal(r.lead.tenantId, 1); assert.notEqual(r.other.tenantId, 1);
  return r;
}
const is = (status: number) => (e: unknown) => e instanceof CollabError && e.status === status;

test("credentials: every team member (member, lead) manages; system admins read-only; masked status; per-team audit", () => {
  const { db, admin, lead, member } = setup();
  const t = lead.tenantId;
  assert.equal(canManageProviders(member), true); assert.equal(canManageProviders(lead), true); assert.equal(canManageProviders(admin), false);
  assert.throws(() => setCredential(db, admin, "claude-code", "ANTHROPIC_API_KEY", "sk-ant-TESTONLY-1234", SK, noEnv), is(403));
  assert.throws(() => setCredential(db, lead, "claude-code", "NOPE", "sk-ant-TESTONLY-1234", SK, noEnv), is(400));
  assert.throws(() => setCredential(db, lead, "bogus", "X", "sk-ant-TESTONLY-1234", SK, noEnv), is(404));
  assert.throws(() => setCredential(db, lead, "claude-code", "ANTHROPIC_API_KEY", "short", SK, noEnv), is(400));
  assert.throws(() => setCredential(db, lead, "openrouter", "OPENROUTER_API_KEY", "sk-or-TESTONLY-1234", SK, noEnv), is(404));
  const v = setCredential(db, member, "claude-code", "ANTHROPIC_API_KEY", "sk-ant-TESTONLY-1234", SK, noEnv, 1000);
  assert.equal(v.set, true); assert.equal(v.last4, "1234"); assert.equal(v.setBy, "m@a.com"); assert.equal(v.setAt, 1000);
  assert.ok(!JSON.stringify(v).includes("TESTONLY"));
  setCredential(db, lead, "claude-code", "ANTHROPIC_API_KEY", "sk-ant-TESTONLY-9999", SK, noEnv, 2000);
  assert.equal(storedCredential(db, t, "claude-code", "ANTHROPIC_API_KEY", SK), "sk-ant-TESTONLY-9999");
  // the read-only view gets set/unset only
  const mv = credentialViews(db, t, "claude-code", SK, noEnv, false).find((c) => c.name === "ANTHROPIC_API_KEY")!;
  assert.equal(mv.set, true); assert.equal(mv.last4, null); assert.equal(mv.setBy, null);
  setCredential(db, member, "claude-code", "ANTHROPIC_API_KEY", null, SK, noEnv, 3000);
  assert.throws(() => setCredential(db, lead, "claude-code", "ANTHROPIC_API_KEY", null, SK, noEnv), is(404));
  const log = listProviderAudit(db, t);
  assert.deepEqual(log.slice(0, 3).map((l) => [l.actorEmail, l.detail]), [["m@a.com", "ANTHROPIC_API_KEY deleted"], ["lead@a.com", "ANTHROPIC_API_KEY replaced"], ["m@a.com", "ANTHROPIC_API_KEY set"]]);
});

test("credentials: cross-team isolation and the env fallback for team 1 only", () => {
  const { db, lead, other, otherLead } = setup();
  const a = lead.tenantId, b = other.tenantId;
  setCredential(db, lead, "codex", "CODEX_API_KEY", "cur-TEAM-A-0001", SK, noEnv, 1);
  setCredential(db, other, "codex", "CODEX_API_KEY", "cur-TEAM-B-0002", SK, noEnv, 2);
  assert.equal(storedCredential(db, a, "codex", "CODEX_API_KEY", SK), "cur-TEAM-A-0001");
  assert.equal(storedCredential(db, b, "codex", "CODEX_API_KEY", SK), "cur-TEAM-B-0002");
  assert.deepEqual(builtinCredentialSecrets(db, b, SK), ["cur-TEAM-B-0002"], "team b's redaction list has only its own key");
  setCredential(db, otherLead, "codex", "CODEX_API_KEY", null, SK, noEnv, 3);
  assert.equal(storedCredential(db, a, "codex", "CODEX_API_KEY", SK), "cur-TEAM-A-0001", "deleting in team b leaves team a alone");
  assert.throws(() => setCredential(db, other, "claude-code", "ANTHROPIC_API_KEY", null, SK, noEnv), is(404), "can't delete another team's row");
  // audit is per team
  assert.ok(listProviderAudit(db, a).every((l) => l.actorEmail === "lead@a.com"));
  assert.deepEqual(listProviderAudit(db, b).map((l) => l.actorEmail), ["ol@b.com", "o@b.com"]);
  // env fallback: team 1 only
  const env = (n: string) => (n === "ANTHROPIC_API_KEY" ? "from-env-file" : undefined);
  assert.equal(credentialViews(db, a, "claude-code", SK, env, true)[0].source, "env");
  assert.equal(credentialViews(db, b, "claude-code", SK, env, true)[0].set, false);
  assert.equal(resolveCredential(db, a, "claude-code", "ANTHROPIC_API_KEY", SK, env), "from-env-file");
  assert.equal(resolveCredential(db, b, "claude-code", "ANTHROPIC_API_KEY", SK, env), undefined);
  // auth methods per team
  setAuthMode(db, other, "codex", "api_key");
  assert.equal(getAuthMode(db, b, "codex").mode, "api_key"); assert.equal(getAuthMode(db, a, "codex").mode, "auto");
});

test("auth method: team members only, per-provider allowed modes, audited", () => {
  const { db, admin, member } = setup();
  const t = member.tenantId;
  assert.equal(getAuthMode(db, t, "claude-code").mode, "auto");
  assert.throws(() => setAuthMode(db, admin, "codex", "api_key"), is(403));
  assert.throws(() => setAuthMode(db, member, "codex", "weird"), is(400));
  assert.equal(setAuthMode(db, member, "codex", "subscription").mode, "subscription");
  assert.equal(listProviderAudit(db, t)[0].detail, "auth method auto -> subscription");
});

test("runAuth: Claude Code and Codex use only the chosen credential", () => {
  const c = (m: Record<string, string>) => (n: string) => m[n];
  const both = c({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "key" });
  assert.deepEqual(runAuth("claude-code", "auto", both, false), { env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth" }, unset: ["ANTHROPIC_API_KEY"], note: "claude-code: using the subscription token" });
  assert.deepEqual(runAuth("claude-code", "api_key", both, false).env, { ANTHROPIC_API_KEY: "key" });
  assert.deepEqual(runAuth("claude-code", "api_key", both, false).unset, ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.throws(() => runAuth("claude-code", "subscription", c({ ANTHROPIC_API_KEY: "k" }), false), /setup-token/);
  assert.throws(() => runAuth("claude-code", "api_key", c({ CLAUDE_CODE_OAUTH_TOKEN: "o" }), false), /API key/);
  const cx = c({ CODEX_API_KEY: "ck", CODEX_ACCESS_TOKEN: "tok" });
  assert.deepEqual(runAuth("codex", "api_key", cx, true).env, { CODEX_API_KEY: "ck" });
  { const ra = runAuth("codex", "subscription", cx, true); assert.deepEqual(ra.env, {}, "never via CODEX_ACCESS_TOKEN"); assert.equal(ra.codexLogin, "tok"); assert.ok(ra.unset.includes("CODEX_ACCESS_TOKEN")); }
  const sub = runAuth("codex", "subscription", c({ CODEX_API_KEY: "ck" }), true);
  assert.deepEqual(sub.env, {}); assert.ok(sub.unset.includes("CODEX_API_KEY") && sub.unset.includes("OPENAI_API_KEY"));
  assert.throws(() => runAuth("codex", "subscription", c({}), false), /ChatGPT login/);
  assert.deepEqual(runAuth("codex", "auto", c({ CODEX_API_KEY: "ck" }), true).env, {}, "auto prefers the server ChatGPT login");
  assert.deepEqual(runAuth("codex", "auto", c({ CODEX_API_KEY: "ck" }), false).env, { CODEX_API_KEY: "ck" });
  // no CLI-login fallback (teams other than 1): a clear error instead of the server's logins
  assert.throws(() => runAuth("claude-code", "auto", c({}), false, false), /no credential set for this team/);
  assert.throws(() => runAuth("codex", "auto", c({}), false, false), /no credential set for this team/);
  assert.equal(runAuth("claude-code", "auto", c({}), false, true).note, "claude-code: no stored credential; using the CLI's own login");
});

test("migration 28: existing credentials, auth modes and custom providers move to team 1; OpenRouter stays global", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, 27);
  db.exec(`INSERT INTO tenants (id, slug, name, created_at) VALUES (1, 'vic', 'Vic', 1), (2, 'b', 'B', 1);
    INSERT INTO provider_secrets VALUES ('cursor', 'CURSOR_API_KEY', 'enc1', 1, 'x'), ('openrouter', 'OPENROUTER_API_KEY', 'enc2', 1, 'x'), ('custom:tg', 'API_KEY', 'enc3', 1, 'x');
    INSERT INTO provider_auth VALUES ('codex', 'api_key', 1, 'x');
    INSERT INTO custom_providers VALUES ('tg', 'TG', 'https://x.test/v1', '["m"]', 1, 'x', 1, 'x');
    INSERT INTO provider_audit (actor_email, engine, at, detail) VALUES ('x', 'cursor', 1, 'CURSOR_API_KEY set'), ('x', 'codex', 1, NULL);`);
  migrate(db);
  assert.deepEqual(db.prepare("SELECT tenant_id, engine FROM team_provider_secrets ORDER BY engine").all().map((r) => ({ ...r })), [{ tenant_id: 1, engine: "cursor" }, { tenant_id: 1, engine: "custom:tg" }]);
  assert.deepEqual(db.prepare("SELECT engine FROM provider_secrets").all().map((r) => ({ ...r })), [{ engine: "openrouter" }]);
  assert.deepEqual(db.prepare("SELECT tenant_id, engine, mode FROM team_provider_auth").all().map((r) => ({ ...r })), [{ tenant_id: 1, engine: "codex", mode: "api_key" }]);
  assert.deepEqual(db.prepare("SELECT tenant_id, id FROM team_custom_providers").all().map((r) => ({ ...r })), [{ tenant_id: 1, id: "tg" }]);
  assert.deepEqual(db.prepare("SELECT tenant_id FROM provider_audit ORDER BY id").all().map((r) => (r as { tenant_id: number | null }).tenant_id), [1, null]);
});

test("runner: claude/codex env follows the auth method; removed engines are gone", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-pc-")), out = path.join(tmp, "out.txt"), fake = path.join(tmp, "fake.sh");
  writeFileSync(fake, `#!/bin/sh\n{ echo "A=$ANTHROPIC_API_KEY"; echo "O=$CLAUDE_CODE_OAUTH_TOKEN"; echo "CK=$CODEX_API_KEY"; echo "CT=$CODEX_ACCESS_TOKEN"; echo "CP=$COBRA_CP_TOGETHER_KEY"; cat "$XDG_CONFIG_HOME/opencode/opencode.json" 2>/dev/null; echo; for a in "$@"; do echo "ARG=$a"; done; } > ${out}\necho '{}'\n`); chmodSync(fake, 0o755);
  const store: Record<string, string> = { ANTHROPIC_API_KEY: "ant-key", CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok", CODEX_API_KEY: "cx-key" };
  let mode: "auto" | "api_key" | "subscription" = "api_key", n = 0;
  const go = (driver: "claude-code" | "codex", model?: string) => localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, claudeBin: fake, codexBin: fake,
    credential: (_e, name) => store[name], authMode: () => mode, codexServerLogin: () => true, })(
    { runId: `r${++n}`, driver, with: { prompt: "hi", ...(model ? { model } : {}) }, secrets: {}, signal: new AbortController().signal, log: () => {} });
  const o = () => readFileSync(out, "utf8");
  const prevHome = process.env.HOME; process.env.HOME = path.join(tmp, "home");
  try {
    await go("claude-code"); assert.match(o(), /A=ant-key\nO=\n/);
    mode = "subscription"; await go("claude-code"); assert.match(o(), /A=\nO=oauth-tok\n/);
    mode = "api_key"; await go("codex"); assert.match(o(), /CK=cx-key\nCT=\n/);
    mode = "subscription"; await go("codex"); assert.match(o(), /CK=\nCT=\n/, "server ChatGPT login: no key vars");
  } finally { process.env.HOME = prevHome; }
});

