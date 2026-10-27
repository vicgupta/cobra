// Codex (Subscription) ChatGPT login: parse/validate a pasted auth.json or bare token, masked status, the
// per-run CODEX_HOME/auth.json the runner writes (never CODEX_ACCESS_TOKEN), refresh write-back and cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { buildAuthJson, codexLoginSecrets, codexLoginStatus, parseCodexLogin, refreshedLogin } from "../lib/codex-login";
import { builtinCredentialSecrets, credentialViews, saveRefreshedCodexLogin, setCredential, storedCredential } from "../lib/provider-credentials";
import { listProviderAudit } from "../lib/providers";
import { localRunner } from "../lib/workflows/local-runner";

const NOW = Date.UTC(2026, 9, 27, 12);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Synthetic, unsigned test JWTs (not real credentials).
const jwt = (o: { iss?: string; exp?: number | null; plan?: string; tag?: string }) =>
  `${b64({ alg: "none" })}.${b64({ iss: o.iss ?? "https://auth.openai.com", ...(o.exp === null ? {} : { exp: Math.floor((o.exp ?? NOW + 9 * 864e5) / 1000) }), tag: o.tag ?? "a", "https://api.openai.com/auth": { chatgpt_plan_type: o.plan ?? "plus", chatgpt_account_id: "acct-1" } })}.c2ln`;
const authJson = (p: { access?: string; refresh?: string; extra?: object } = {}) => JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { id_token: jwt({ tag: "id" }), access_token: p.access ?? jwt({}), refresh_token: p.refresh ?? "rt_test_refresh_token_value", oauth_provenance: { issuer: "https://auth.openai.com", client_id: "app_x" }, login_owner_id: "o", account_id: "acct-1" },
  last_refresh: "2026-10-26T22:47:00Z", ...p.extra }, null, 2);
const rejects = (v: unknown, re: RegExp) => assert.throws(() => parseCodexLogin(v, NOW), (e: unknown) => e instanceof CollabError && e.status === 400 && re.test(e.message));

test("parse: accepts auth.json (keeps every field) and a bare access token", () => {
  const raw = authJson(), out = parseCodexLogin(`\n  ${raw}\n`, NOW);
  assert.deepEqual(JSON.parse(out), JSON.parse(raw));
  const tok = jwt({}); assert.equal(parseCodexLogin(` ${tok} `, NOW), tok);
  // an expired access token is fine when the CLI can refresh it
  assert.doesNotThrow(() => parseCodexLogin(authJson({ access: jwt({ exp: NOW - 1000 }) }), NOW));
});

test("parse: clear rejection messages", () => {
  rejects(42, /must be a string/);
  rejects("   ", /paste the contents/);
  rejects("sk-proj-abcdefghijklmnop", /API key, not a ChatGPT login/);
  rejects("not-a-token", /three dot-separated/);
  rejects(jwt({ iss: "https://accounts.google.com" }), /wasn't issued by https:\/\/auth.openai.com/);
  rejects(jwt({ exp: NOW - 1000 }), /expired on 2026-10-27.*codex login/);
  rejects(jwt({ exp: null }), /no expiry/);
  rejects(`${jwt({})} extra`, /no spaces or line breaks/);
  rejects("{ not json", /doesn't parse/);
  rejects("[]", /JSON object/);
  rejects(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }), /"apikey" login/);
  rejects(JSON.stringify({ OPENAI_API_KEY: "sk-x" }), /holds an API key/);
  rejects(JSON.stringify({ auth_mode: "chatgpt" }), /no "tokens" section/);
  rejects(JSON.stringify({ tokens: { access_token: jwt({}) } }), /missing tokens.id_token/);
  rejects(authJson({ access: jwt({ exp: NOW - 1000 }), refresh: "" }), /expired on/);
  rejects("x".repeat(20_001), /too long/);
});

test("status: masked plan / expiry / refresh; never a token", () => {
  const s = codexLoginStatus(parseCodexLogin(authJson(), NOW), NOW)!;
  assert.deepEqual(s, { kind: "auth_json", plan: "plus", expiresAt: Math.floor((NOW + 9 * 864e5) / 1000) * 1000, canRefresh: true, expired: false });
  const t = codexLoginStatus(jwt({ plan: "pro" }), NOW)!;
  assert.equal(t.kind, "token"); assert.equal(t.plan, "pro"); assert.equal(t.canRefresh, false);
  assert.equal(codexLoginStatus("garbage"), null);
});

test("auth.json for the CLI: the 0.164.0 shape, from a bare token or the stored file", () => {
  const tok = jwt({}), j = JSON.parse(buildAuthJson(tok, NOW));
  assert.deepEqual(j, { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: tok, access_token: tok, refresh_token: "", account_id: "acct-1" }, last_refresh: new Date(NOW).toISOString() });
  const stored = parseCodexLogin(authJson(), NOW);
  assert.deepEqual(JSON.parse(buildAuthJson(stored, NOW)), JSON.parse(stored));
  assert.throws(() => buildAuthJson("garbage"), /pastes ~\/.codex\/auth.json again/);
});

test("refresh detection and redaction", () => {
  const before = parseCodexLogin(authJson(), NOW);
  assert.equal(refreshedLogin(before, null), null);
  assert.equal(refreshedLogin(before, before), null, "unchanged");
  assert.equal(refreshedLogin(before, JSON.stringify(JSON.parse(before), null, 2)), null, "reformatted only");
  assert.equal(refreshedLogin(jwt({}), buildAuthJson(jwt({}), NOW)), null, "bare token written back unchanged");
  const after = authJson({ access: jwt({ tag: "new" }), refresh: "rt_rotated_refresh_value" });
  assert.equal(JSON.parse(refreshedLogin(before, after)!).tokens.refresh_token, "rt_rotated_refresh_value");
  assert.equal(refreshedLogin(before, "{ broken"), null);
  const sec = codexLoginSecrets(before);
  assert.ok(sec.includes("rt_test_refresh_token_value") && sec.includes(JSON.parse(before).tokens.access_token) && sec.includes(before));
});

const SK = Buffer.alloc(32, 9).toString("base64");
function setup() {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "lead@a.com", tenant: "a", tenantName: "a", role: "team_lead", password: "pw-1234567890" });
  return { db, u: { id, email: "lead@a.com", role: "team_lead", tenantId: 1 } };
}

test("settings: saving validates, stores encrypted, audits, and the view never carries the value", () => {
  const { db, u } = setup();
  assert.throws(() => setCredential(db, u, "codex", "CODEX_ACCESS_TOKEN", jwt({ exp: NOW - 1 }), SK, () => undefined, NOW), /expired/);
  const raw = authJson();
  const v = setCredential(db, u, "codex", "CODEX_ACCESS_TOKEN", raw, SK, () => undefined, Date.now());
  assert.equal(v.last4, null); assert.equal(v.codexLogin?.canRefresh, true); assert.equal(v.codexLogin?.plan, "plus");
  assert.ok(!JSON.stringify(v).includes("rt_test_refresh") && !JSON.stringify(v).includes(JSON.parse(raw).tokens.access_token));
  const enc = (db.prepare("SELECT value_enc FROM team_provider_secrets").get() as { value_enc: string }).value_enc;
  assert.ok(!enc.includes("rt_test_refresh"));
  assert.deepEqual(JSON.parse(storedCredential(db, 1, "codex", "CODEX_ACCESS_TOKEN", SK)!), JSON.parse(raw));
  assert.ok(builtinCredentialSecrets(db, 1, SK).includes("rt_test_refresh_token_value"), "tokens inside auth.json are redacted from logs");
  saveRefreshedCodexLogin(db, 1, authJson({ refresh: "rt_rotated_refresh_value" }), SK);
  assert.match(storedCredential(db, 1, "codex", "CODEX_ACCESS_TOKEN", SK)!, /rt_rotated_refresh_value/);
  const audit = listProviderAudit(db, 1).map((a) => `${a.actorEmail}: ${a.detail}`);
  assert.ok(audit.some((a) => a === "lead@a.com: CODEX_ACCESS_TOKEN set"), audit.join("\n"));
  assert.ok(audit.some((a) => /^codex \(auto-refresh\): CODEX_ACCESS_TOKEN refreshed/.test(a)), audit.join("\n"));
  assert.equal(credentialViews(db, 1, "codex", SK, () => undefined, true).find((c) => c.name === "CODEX_ACCESS_TOKEN")?.setBy, "codex (auto-refresh)");
});

test("runner: per-run CODEX_HOME/auth.json (600), no CODEX_ACCESS_TOKEN, refresh write-back, removed afterwards", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-cxl-")), out = path.join(tmp, "out.txt"), fake = path.join(tmp, "codex.sh");
  // Fake CLI: records what it sees, then (when asked) rotates the tokens like a real refresh would.
  writeFileSync(fake, `#!/bin/sh
{ echo "CT=$CODEX_ACCESS_TOKEN"; echo "CK=$CODEX_API_KEY"; echo "HOME_OK=$(case "$CODEX_HOME" in *"/.git/cobra-codex-home") echo y;; esac)"; echo "MODE=$(stat -c %a "$CODEX_HOME/auth.json")"; echo "AUTH=$(tr -d '\\n' < "$CODEX_HOME/auth.json")"; } > ${out}
[ -f ${tmp}/rotate ] && cp ${tmp}/rotate "$CODEX_HOME/auth.json"
[ -f ${tmp}/fail ] && exit 3
echo '{}'
`); chmodSync(fake, 0o755);
  const tok = jwt({}), saved: string[] = [];
  let login = tok, n = 0;
  const go = () => localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, codexBin: fake,
    credential: (_e, name) => (name === "CODEX_ACCESS_TOKEN" ? login : undefined), authMode: () => "subscription", codexServerLogin: () => false, onCodexLoginRefresh: (j) => saved.push(j) })(
    { runId: `r${++n}`, driver: "codex", with: { prompt: "hi" }, secrets: {}, signal: new AbortController().signal, log: () => {} });
  const o = () => readFileSync(out, "utf8");
  const prev = process.env.CODEX_ACCESS_TOKEN; process.env.CODEX_ACCESS_TOKEN = "server-env-must-not-leak";
  try {
    const r1 = await go();
    assert.match(o(), /^CT=\nCK=\nHOME_OK=y\nMODE=600\n/);
    const written = JSON.parse(o().split("AUTH=")[1]);
    assert.equal(written.auth_mode, "chatgpt"); assert.equal(written.tokens.access_token, tok); assert.equal(written.tokens.refresh_token, "");
    assert.equal(existsSync(path.join(String(r1.workspace), ".git", "cobra-codex-home")), false, "removed after the run");
    assert.equal(r1.files, "", "never committed");
    assert.deepEqual(saved, [], "bare token: nothing to write back");

    login = parseCodexLogin(authJson(), NOW);
    writeFileSync(path.join(tmp, "rotate"), authJson({ access: jwt({ tag: "new" }), refresh: "rt_rotated_refresh_value" }));
    const r2 = await go();
    assert.equal(saved.length, 1); assert.match(saved[0], /rt_rotated_refresh_value/);
    assert.equal(existsSync(path.join(String(r2.workspace), ".git", "cobra-codex-home")), false);

    // a failed run still writes back the refresh and cleans up
    writeFileSync(path.join(tmp, "fail"), "");
    await assert.rejects(go(), /exited with code 3/);
    assert.equal(saved.length, 2);
  } finally { if (prev === undefined) delete process.env.CODEX_ACCESS_TOKEN; else process.env.CODEX_ACCESS_TOKEN = prev; }
});
