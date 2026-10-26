// OpenRouter: one global encrypted key (admin-only, never returned, audited), per-engine per-run wiring
// (OpenCode native, Codex per-run CODEX_HOME provider, Claude Code Anthropic-compatible base URL), Cursor
// rejected, picker data, usage provider 'openrouter', redaction, env fallback, same key for every team.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { createAgent } from "../lib/agents";
import { CollabError } from "../lib/collab";
import { allModels, checkModel, isOpenRouterModel, modelArgs, OPENROUTER_MODELS, openRouterModelsFor } from "../lib/agent-models";
import { listProviderAudit, setProviderDefaults } from "../lib/providers";
import { getOpenRouterKey, openRouterStatus, setOpenRouterKey } from "../lib/openrouter";
import { localRunner, openRouterRunConfig, OPENROUTER_API_BASE, OPENROUTER_ANTHROPIC_BASE } from "../lib/workflows/local-runner";
import { recordUsage, usageCollector, usageReport } from "../lib/usage";
import { redact } from "../lib/workflows/engine";

const KEY = Buffer.alloc(32, 9).toString("base64");
const OR = "sk-or-v1-TESTONLY0123456789abcdef";
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, tenant: string, role: "admin" | "team_lead" | "member") => ({ id: createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" }), email, role });
  return { db, admin: mk("admin@a.com", "a", "admin"), lead: mk("lead@a.com", "a", "team_lead"), member: mk("m@a.com", "a", "member"), member2: mk("m@b.com", "b", "member") };
}
const is = (status: number) => (e: unknown) => e instanceof CollabError && e.status === status;
const tid = (db: ReturnType<typeof openDb>, id: number) => (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;

test("openrouter key: global row, encrypted at rest, admin-only set/clear (403), never returned, audited without the value", () => {
  const { db, admin, lead, member } = setup();
  assert.equal(openRouterStatus(db).set, false);
  assert.throws(() => setOpenRouterKey(db, member, OR, KEY), is(403));
  assert.throws(() => setOpenRouterKey(db, lead, OR, KEY), is(403));
  assert.throws(() => setOpenRouterKey(db, member, null, KEY), is(403), "non-admin can't clear");
  assert.throws(() => setOpenRouterKey(db, admin, "short", KEY), is(400));
  assert.throws(() => setOpenRouterKey(db, admin, OR, undefined), is(503), "no COBRA_SECRET_KEY: not stored in plaintext");
  const v = setOpenRouterKey(db, admin, OR, KEY, 42);
  assert.equal(v.set, true); assert.equal(v.source, "stored"); assert.equal(v.setBy, "admin@a.com");
  assert.ok(!JSON.stringify(v).includes(OR) && !JSON.stringify(openRouterStatus(db)).includes(OR), "status never carries the key");
  const rows = db.prepare("SELECT * FROM provider_secrets").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1); assert.equal(rows[0].engine, "openrouter");
  assert.ok(!("tenant_id" in rows[0]), "global, not tenant-scoped");
  assert.ok(!JSON.stringify(rows).includes(OR), "encrypted at rest");
  assert.equal(getOpenRouterKey(db, KEY), OR);
  assert.equal(getOpenRouterKey(db, Buffer.alloc(32, 1).toString("base64")), undefined, "wrong COBRA_SECRET_KEY: no key");
  const cleared = setOpenRouterKey(db, admin, null, KEY, 43);
  assert.equal(cleared.set, false); assert.equal(getOpenRouterKey(db, KEY), undefined);
  const audit = listProviderAudit(db, 1).filter((a) => a.engine === "openrouter");
  assert.deepEqual(audit.map((a) => [a.actorEmail, a.detail, a.at]), [["admin@a.com", "OPENROUTER_API_KEY cleared", 43], ["admin@a.com", "OPENROUTER_API_KEY set", 42]]);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM provider_audit").all()).includes(OR));
});

test("openrouter key: COBRA_OPENROUTER_API_KEY env fallback; stored key wins", () => {
  const { db, admin } = setup();
  assert.equal(getOpenRouterKey(db, KEY, "sk-or-env-fallback-1234"), "sk-or-env-fallback-1234");
  const s = openRouterStatus(db, "sk-or-env-fallback-1234");
  assert.equal(s.set, true); assert.equal(s.source, "env"); assert.ok(!JSON.stringify(s).includes("fallback-1234"));
  setOpenRouterKey(db, admin, OR, KEY);
  assert.equal(getOpenRouterKey(db, KEY, "sk-or-env-fallback-1234"), OR);
  assert.equal(getOpenRouterKey(db, KEY, undefined), OR);
});

test("openrouter picker data: curated ids per engine, custom ids, Cursor rejected", () => {
  const m = allModels({});
  assert.ok(m["claude-code"].includes("claude-sonnet-5-5"), "Claude list keeps claude-sonnet-5-5");
  for (const e of ["claude-code", "codex", "opencode"] as const) assert.ok(m[e].some(isOpenRouterModel), e);
  assert.ok(m.opencode.includes("openrouter/qwen/qwen3-coder") && m.codex.includes("openrouter/openai/gpt-5") && m.codex.includes("openrouter/google/gemini-2.5-pro"));
  assert.ok(m["claude-code"].includes("openrouter/anthropic/claude-sonnet-4.5") && openRouterModelsFor("claude-code").every((x) => x.startsWith("openrouter/anthropic/")));
  assert.deepEqual(openRouterModelsFor("cursor"), []); assert.ok(!m.cursor.some(isOpenRouterModel));
  assert.ok(OPENROUTER_MODELS.includes("deepseek/deepseek-v4-pro"));
  assert.equal(checkModel("codex", "openrouter/mistralai/devstral-2", {}), "openrouter/mistralai/devstral-2", "custom id");
  assert.throws(() => checkModel("cursor", "openrouter/anthropic/claude-sonnet-4.5", {}), /can't use OpenRouter/);
  assert.throws(() => checkModel("codex", "openrouter/bad id", {}));
  assert.throws(() => checkModel("codex", "openrouter/onlyvendor", {}));
  assert.deepEqual(modelArgs("opencode", "openrouter/qwen/qwen3-coder"), ["-m", "openrouter/qwen/qwen3-coder"]);
  assert.deepEqual(modelArgs("codex", "openrouter/openai/gpt-5"), ["-m", "openai/gpt-5"]);
  assert.deepEqual(modelArgs("claude-code", "openrouter/anthropic/claude-sonnet-4.5"), ["--model", "anthropic/claude-sonnet-4.5"]);
  const { db, admin, member } = setup();
  const u = { id: member.id, role: "member" as const, tenantId: tid(db, member.id) };
  assert.equal(createAgent(db, u, { name: "or-a", engine: "opencode", model: "openrouter/z-ai/glm-5.3", prompt: "p" }).model, "openrouter/z-ai/glm-5.3");
  assert.throws(() => createAgent(db, u, { name: "or-c", engine: "cursor", model: "openrouter/openai/gpt-5", prompt: "p" }));
  assert.deepEqual(setProviderDefaults(db, admin, "codex", { model: "openrouter/openai/gpt-5" }, 1, {}), { model: "openrouter/openai/gpt-5", effort: null });
  const st = openRouterStatus(db);
  assert.deepEqual(st.engines.map((e) => [e.engine, e.supported]), [["claude-code", true], ["codex", true], ["opencode", true], ["cursor", false]]);
});

test("openrouter per-engine config builders: base URLs, key per run only, Cursor rejected", () => {
  const oc = openRouterRunConfig("opencode", OR, "/ws/r1");
  assert.deepEqual(oc.env, { OPENROUTER_API_KEY: OR });
  const cc = openRouterRunConfig("claude-code", OR, "/ws/r1");
  assert.deepEqual(cc.env, { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: OR, ANTHROPIC_API_KEY: "" });
  assert.ok(cc.unset.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.equal(OPENROUTER_ANTHROPIC_BASE, "https://openrouter.ai/api"); assert.equal(OPENROUTER_API_BASE, "https://openrouter.ai/api/v1");
  const cx = openRouterRunConfig("codex", OR, "/ws/r1");
  assert.equal(cx.env.CODEX_HOME, "/ws/r1/.git/cobra-codex-home");
  assert.match(cx.codexHome!.configToml, /model_provider = "openrouter"/);
  assert.match(cx.codexHome!.configToml, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
  assert.match(cx.codexHome!.configToml, /env_key = "OPENROUTER_API_KEY"/);
  assert.ok(!cx.codexHome!.configToml.includes(OR), "the key is never written into config.toml");
  assert.throws(() => openRouterRunConfig("cursor", OR, "/ws/r1"), /can't use OpenRouter/);
});

test("openrouter runs: env per run, shared ~/.codex untouched, normal runs unaffected, team 2 uses the same global key, usage + redaction", async () => {
  const { db, admin, member, member2 } = setup();
  setOpenRouterKey(db, admin, OR, KEY);
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-or-"));
  const fake = path.join(tmp, "fake"), out = path.join(tmp, "out");
  writeFileSync(fake, `#!/bin/sh
{ for a in "$@"; do echo "ARG=$a"; done
  echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"; echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"; echo "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN"
  echo "ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY-unset}"; echo "OAUTH=$CLAUDE_CODE_OAUTH_TOKEN"; echo "CODEX_HOME=$CODEX_HOME"
  [ -n "$CODEX_HOME" ] && cat "$CODEX_HOME/config.toml"; } > ${out}
echo '{"type":"result","result":"done","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":3}}'
exit 0
`); chmodSync(fake, 0o755);
  const home = path.join(tmp, "home"); mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "config.toml"), "# shared\n"); writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
  const prevHome = process.env.HOME; process.env.HOME = home;
  const usage: Array<[string, { provider: string; model: string | null; cost_usd: number | null; input_tokens: number | null }]> = [];
  const mkRun = () => localRunner({ root: path.join(tmp, "ws"), resolveSecret: (n) => (n === "CLAUDE_CODE_OAUTH_TOKEN" ? "oauth-normal" : undefined), checkRepo: () => null, claudeBin: fake, codexBin: fake, opencodeBin: fake, cursorBin: fake,
    openRouterKey: () => getOpenRouterKey(db, KEY), providerSecret: () => "cur_key_12345678", onUsage: (k, u) => usage.push([k, u]) });
  let n = 0;
  const go = (driver: "claude-code" | "codex" | "opencode" | "cursor", model?: string) => mkRun()({ runId: `r${++n}`, driver, with: { prompt: "hi", ...(model ? { model } : {}) }, secrets: {}, signal: new AbortController().signal, log: () => {} });
  const o = () => readFileSync(out, "utf8");
  try {
    // team a (member) and team b (member2) both resolve the one global key
    await go("claude-code", "openrouter/anthropic/claude-sonnet-4.5");
    assert.match(o(), /ANTHROPIC_BASE_URL=https:\/\/openrouter\.ai\/api\n/); assert.match(o(), new RegExp(`ANTHROPIC_AUTH_TOKEN=${OR}`));
    assert.match(o(), /ANTHROPIC_API_KEY=\n/); assert.match(o(), /OAUTH=\n/); assert.match(o(), /ARG=anthropic\/claude-sonnet-4\.5/);
    assert.equal(usage.at(-1)![1].provider, "openrouter"); assert.equal(usage.at(-1)![1].model, "anthropic/claude-sonnet-4.5");
    assert.equal(usage.at(-1)![1].input_tokens, 10); assert.equal(usage.at(-1)![1].cost_usd, null, "Claude Code's local price estimate isn't stored for OpenRouter");
    await go("claude-code", "sonnet");
    assert.match(o(), /OAUTH=oauth-normal/); assert.match(o(), /ANTHROPIC_BASE_URL=\n/); assert.match(o(), /OPENROUTER_API_KEY=\n/, "normal Claude runs get no OpenRouter key");
    assert.equal(usage.at(-1)![1].provider, "claude-code");
    const r = await go("codex", "openrouter/openai/gpt-5");
    assert.match(o(), /CODEX_HOME=.*\/r3\/\.git\/cobra-codex-home/); assert.match(o(), /model_provider = "openrouter"/); assert.match(o(), new RegExp(`OPENROUTER_API_KEY=${OR}`));
    assert.match(o(), /ARG=openai\/gpt-5\n/);
    assert.ok(!existsSync(path.join(String(r.workspace), ".git", "cobra-codex-home")), "per-run CODEX_HOME removed");
    assert.equal(readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), "# shared\n", "shared ~/.codex/config.toml untouched");
    assert.equal(readFileSync(path.join(home, ".codex", "auth.json"), "utf8"), "{}");
    await go("codex", "gpt-6-sol");
    assert.match(o(), /CODEX_HOME=\n/); assert.match(o(), /OPENROUTER_API_KEY=\n/);
    await go("opencode", "openrouter/qwen/qwen3-coder");
    assert.match(o(), new RegExp(`OPENROUTER_API_KEY=${OR}`)); assert.match(o(), /ARG=openrouter\/qwen\/qwen3-coder/);
    assert.equal(usage.at(-1)![1].provider, "openrouter");
    await assert.rejects(go("cursor", "openrouter/openai/gpt-5"), /can't use OpenRouter/);
    // a team-b runner (same global resolver) gets the same key
    const keys = [tid(db, member.id), tid(db, member2.id)].map(() => getOpenRouterKey(db, KEY));
    assert.deepEqual(keys, [OR, OR]);
    assert.notEqual(tid(db, member.id), tid(db, member2.id));
    // no key: clear error, nothing run
    setOpenRouterKey(db, admin, null, KEY);
    await assert.rejects(go("opencode", "openrouter/qwen/qwen3-coder"), /OpenRouter has no API key/);
  } finally { process.env.HOME = prevHome; }
  // redaction: the key never survives into logs
  assert.ok(!redact(`token ${OR} end`, [OR]).includes(OR));
  assert.ok(!redact(`ANTHROPIC_AUTH_TOKEN=${OR}`, [OR]).includes(OR));
});

test("openrouter usage: provider 'openrouter' appears in the usage breakdown", () => {
  const { db, member } = setup();
  const t = tid(db, member.id);
  const now = Date.now();
  db.prepare("INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at, status) VALUES ('run_or', ?, NULL, '', '', 0, 't', '', 0, ?, 'succeeded')").run(t, now);
  const uc = usageCollector("openrouter", "anthropic/claude-sonnet-4.5", () => {}, { openRouter: true });
  uc.write('{"type":"result","result":"ok","total_cost_usd":0.9,"usage":{"input_tokens":12,"output_tokens":4},"modelUsage":{"claude-sonnet-4-5":{}}}');
  const r = uc.finish();
  assert.deepEqual([r.usage!.provider, r.usage!.model, r.usage!.input_tokens, r.usage!.cost_usd], ["openrouter", "anthropic/claude-sonnet-4.5", 12, null]);
  recordUsage(db, "run_or", r.usage!);
  const rep = usageReport(db, "all", { now });
  assert.deepEqual(rep.providers.map((p) => [p.provider, p.input_tokens, p.cost_usd]), [["openrouter", 12, null]]);
});
