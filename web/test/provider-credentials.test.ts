// Settings > Providers credential manager: slots, masked status, admin-only set/replace/delete with audit,
// auth method per provider, runner selection by method, custom OpenAI-compatible providers on OpenCode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { checkModel, allModels } from "../lib/agent-models";
import { listProviderAudit, getProviderSecret } from "../lib/providers";
import {
  addCustomProvider, credentialViews, customModelIds, customProviderViews, deleteCustomProvider, getAuthMode,
  opencodeCustomConfig, runAuth, setAuthMode, setCredential, storedCredential, updateCustomProvider, customEnvName,
} from "../lib/provider-credentials";
import { localRunner } from "../lib/workflows/local-runner";

const SK = Buffer.alloc(32, 7).toString("base64");
const noEnv = () => undefined;
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member") => ({ id: createUser(db, { email, tenant: "a", tenantName: "a", role, password: "pw-1234567890" }), email, role });
  return { db, admin: mk("admin@a.com", "admin"), lead: mk("lead@a.com", "team_lead"), member: mk("m@a.com", "member") };
}
const is = (status: number) => (e: unknown) => e instanceof CollabError && e.status === status;

test("credentials: admin-only set / replace / delete, masked status (last 4), audit, env fallback", () => {
  const { db, admin, lead, member } = setup();
  for (const u of [lead, member]) assert.throws(() => setCredential(db, u, "claude-code", "ANTHROPIC_API_KEY", "sk-ant-TESTONLY-1234", SK, noEnv), is(403));
  assert.throws(() => setCredential(db, admin, "claude-code", "NOPE", "sk-ant-TESTONLY-1234", SK, noEnv), is(400));
  assert.throws(() => setCredential(db, admin, "bogus", "X", "sk-ant-TESTONLY-1234", SK, noEnv), is(404));
  assert.throws(() => setCredential(db, admin, "claude-code", "ANTHROPIC_API_KEY", "short", SK, noEnv), is(400));
  assert.throws(() => setCredential(db, admin, "openrouter", "OPENROUTER_API_KEY", "sk-or-TESTONLY-1234", SK, noEnv), is(400));
  const v = setCredential(db, admin, "claude-code", "ANTHROPIC_API_KEY", "sk-ant-TESTONLY-1234", SK, noEnv, 1000);
  assert.equal(v.set, true); assert.equal(v.last4, "1234"); assert.equal(v.setBy, "admin@a.com"); assert.equal(v.setAt, 1000);
  assert.ok(!JSON.stringify(v).includes("TESTONLY"));
  setCredential(db, admin, "claude-code", "ANTHROPIC_API_KEY", "sk-ant-TESTONLY-9999", SK, noEnv, 2000);
  assert.equal(storedCredential(db, "claude-code", "ANTHROPIC_API_KEY", SK), "sk-ant-TESTONLY-9999");
  // members get set/unset only
  const mv = credentialViews(db, "claude-code", SK, noEnv, false).find((c) => c.name === "ANTHROPIC_API_KEY")!;
  assert.equal(mv.set, true); assert.equal(mv.last4, null); assert.equal(mv.setBy, null);
  setCredential(db, admin, "claude-code", "ANTHROPIC_API_KEY", null, SK, noEnv, 3000);
  assert.throws(() => setCredential(db, admin, "claude-code", "ANTHROPIC_API_KEY", null, SK, noEnv), is(404));
  const env = (n: string) => (n === "ANTHROPIC_API_KEY" ? "from-env-file" : undefined);
  assert.equal(credentialViews(db, "claude-code", SK, env, true)[0].source, "env");
  const log = listProviderAudit(db).map((l) => l.detail);
  assert.deepEqual(log.slice(0, 3), ["ANTHROPIC_API_KEY deleted", "ANTHROPIC_API_KEY replaced", "ANTHROPIC_API_KEY set"]);
  // the existing Cursor/OpenCode readers see the same storage
  setCredential(db, admin, "cursor", "CURSOR_API_KEY", "cur-TESTONLY-5678", SK, noEnv);
  assert.equal(getProviderSecret(db, "cursor", SK), "cur-TESTONLY-5678");
});

test("auth method: admin-only, per-provider allowed modes, audited", () => {
  const { db, admin, member } = setup();
  assert.equal(getAuthMode(db, "claude-code").mode, "auto");
  assert.equal(getAuthMode(db, "cursor").mode, "api_key");
  assert.throws(() => setAuthMode(db, member, "codex", "api_key"), is(403));
  assert.throws(() => setAuthMode(db, admin, "cursor", "subscription"), is(400));
  assert.throws(() => setAuthMode(db, admin, "codex", "weird"), is(400));
  assert.equal(setAuthMode(db, admin, "codex", "subscription").mode, "subscription");
  assert.equal(listProviderAudit(db)[0].detail, "auth method auto -> subscription");
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
  assert.deepEqual(runAuth("codex", "subscription", cx, true).env, { CODEX_ACCESS_TOKEN: "tok" });
  const sub = runAuth("codex", "subscription", c({ CODEX_API_KEY: "ck" }), true);
  assert.deepEqual(sub.env, {}); assert.ok(sub.unset.includes("CODEX_API_KEY") && sub.unset.includes("OPENAI_API_KEY"));
  assert.throws(() => runAuth("codex", "subscription", c({}), false), /ChatGPT login/);
  assert.deepEqual(runAuth("codex", "auto", c({ CODEX_API_KEY: "ck" }), true).env, {}, "auto prefers the server ChatGPT login");
  assert.deepEqual(runAuth("codex", "auto", c({ CODEX_API_KEY: "ck" }), false).env, { CODEX_API_KEY: "ck" });
});

test("custom providers: CRUD admin-only, validation, model picker, opencode config without keys, audited", () => {
  const { db, admin, member } = setup();
  const base = { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1/", models: "meta-llama/Llama-3.3-70B, qwen-3", apiKey: "tg-TESTONLY-abcd" };
  assert.throws(() => addCustomProvider(db, member, base, SK), is(403));
  assert.throws(() => addCustomProvider(db, admin, { ...base, id: "openai" }, SK), is(400));
  assert.throws(() => addCustomProvider(db, admin, { ...base, baseUrl: "http://evil.example/v1" }, SK), is(400));
  assert.throws(() => addCustomProvider(db, admin, { ...base, models: "" }, SK), is(400));
  assert.throws(() => addCustomProvider(db, admin, { ...base, models: ["bad id"] }, SK), is(400));
  const p = addCustomProvider(db, admin, base, SK, 10);
  assert.equal(p.baseUrl, "https://api.together.xyz/v1");
  assert.throws(() => addCustomProvider(db, admin, base, SK), is(409));
  assert.deepEqual(customModelIds(db), ["together/meta-llama/Llama-3.3-70B", "together/qwen-3"]);
  assert.ok(allModels({}, customModelIds(db)).opencode.includes("together/qwen-3"));
  assert.ok(!allModels({}, customModelIds(db)).codex.includes("together/qwen-3"));
  assert.equal(checkModel("opencode", "together/qwen-3", {}, customModelIds(db)), "together/qwen-3");
  assert.throws(() => checkModel("opencode", "together/qwen-3", {}));
  const v = customProviderViews(db, SK, true)[0];
  assert.equal(v.key.last4, "abcd"); assert.ok(!JSON.stringify(v).includes("TESTONLY"));
  const cfg = opencodeCustomConfig(db, SK);
  assert.ok(!JSON.stringify(cfg.config).includes("TESTONLY"), "the key is never written to opencode.json");
  assert.deepEqual((cfg.config!.provider as Record<string, { options: unknown }>).together.options, { baseURL: "https://api.together.xyz/v1", apiKey: `{env:${customEnvName("together")}}` });
  assert.equal(cfg.env.COBRA_CP_TOGETHER_KEY, "tg-TESTONLY-abcd");
  updateCustomProvider(db, admin, "together", { models: ["qwen-3"], apiKey: null }, SK, 20);
  assert.deepEqual(customModelIds(db), ["together/qwen-3"]);
  assert.equal(customProviderViews(db, SK, true)[0].key.set, false);
  assert.throws(() => deleteCustomProvider(db, member, "together"), is(403));
  updateCustomProvider(db, admin, "together", { apiKey: "tg-TESTONLY-efgh" }, SK);
  deleteCustomProvider(db, admin, "together");
  assert.equal(customModelIds(db).length, 0);
  assert.equal(storedCredential(db, "custom:together", "API_KEY", SK), undefined, "its key is deleted too");
  const log = listProviderAudit(db).map((l) => l.detail ?? "");
  assert.ok(log[0].startsWith("custom provider deleted") && log.some((d) => d.includes("API key deleted")) && log.some((d) => d.startsWith("custom provider added")));
});

test("runner: claude/codex env follows the auth method; opencode gets the custom-provider config", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-pc-")), out = path.join(tmp, "out.txt"), fake = path.join(tmp, "fake.sh");
  writeFileSync(fake, `#!/bin/sh\n{ echo "A=$ANTHROPIC_API_KEY"; echo "O=$CLAUDE_CODE_OAUTH_TOKEN"; echo "CK=$CODEX_API_KEY"; echo "CT=$CODEX_ACCESS_TOKEN"; echo "CP=$COBRA_CP_TOGETHER_KEY"; cat "$XDG_CONFIG_HOME/opencode/opencode.json" 2>/dev/null; echo; for a in "$@"; do echo "ARG=$a"; done; } > ${out}\necho '{}'\n`); chmodSync(fake, 0o755);
  const store: Record<string, string> = { ANTHROPIC_API_KEY: "ant-key", CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok", CODEX_API_KEY: "cx-key" };
  let mode: "auto" | "api_key" | "subscription" = "api_key", n = 0;
  const go = (driver: "claude-code" | "codex" | "opencode", model?: string) => localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, claudeBin: fake, codexBin: fake, opencodeBin: fake,
    credential: (_e, name) => store[name], authMode: () => mode, codexServerLogin: () => true,
    opencodeCustom: () => ({ config: { provider: { together: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://x.test/v1", apiKey: "{env:COBRA_CP_TOGETHER_KEY}" }, models: { "qwen-3": { name: "qwen-3" } } } } }, env: { COBRA_CP_TOGETHER_KEY: "cp-key" } }) })(
    { runId: `r${++n}`, driver, with: { prompt: "hi", ...(model ? { model } : {}) }, secrets: {}, signal: new AbortController().signal, log: () => {} });
  const o = () => readFileSync(out, "utf8");
  const prevHome = process.env.HOME; process.env.HOME = path.join(tmp, "home");
  try {
    await go("claude-code"); assert.match(o(), /A=ant-key\nO=\n/);
    mode = "subscription"; await go("claude-code"); assert.match(o(), /A=\nO=oauth-tok\n/);
    mode = "api_key"; await go("codex"); assert.match(o(), /CK=cx-key\nCT=\n/);
    mode = "subscription"; await go("codex"); assert.match(o(), /CK=\nCT=\n/, "server ChatGPT login: no key vars");
    await go("opencode", "together/qwen-3");
    assert.match(o(), /CP=cp-key/); assert.match(o(), /"baseURL":"https:\/\/x.test\/v1"/); assert.match(o(), /ARG=together\/qwen-3/);
    assert.ok(!o().includes("\"apiKey\":\"cp-key\""));
    assert.ok(!existsSync(path.join(tmp, "ws", `r${n}`, ".git", "cobra-opencode")), "per-run config removed");
  } finally { process.env.HOME = prevHome; }
});
