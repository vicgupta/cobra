// OpenCode + Cursor engines: validation, model/tier per engine, CLI flags, Cursor key masked and admin-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { createAgent } from "../lib/agents";
import { CollabError } from "../lib/collab";
import { ENGINES, isEngine } from "../lib/engines";
import { allModels, modelArgs } from "../lib/agent-models";
import { effortArgs, getProviderSecret, listProviders, providerSecretStatus, providerSecretValues, setProviderDefaults, setProviderSecret } from "../lib/providers";
import { localRunner, opencodeAuthFromCodex } from "../lib/workflows/local-runner";
import { WorkflowSchema } from "../lib/workflows/schema";

const KEY = Buffer.alloc(32, 7).toString("base64");
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member") => ({ id: createUser(db, { email, tenant: "a", tenantName: "a", role, password: "pw-1234567890" }), email, role });
  return { db, admin: mk("admin@a.com", "admin"), lead: mk("lead@a.com", "team_lead"), member: mk("m@a.com", "member") };
}
const is = (status: number) => (e: unknown) => e instanceof CollabError && e.status === status;

test("engines: four engines; validation everywhere; DB accepts them", () => {
  assert.deepEqual([...ENGINES], ["claude-code", "codex", "opencode", "cursor"]);
  assert.ok(isEngine("opencode") && isEngine("cursor") && !isEngine("gemini") && !isEngine("simulate"));
  const { db, member } = setup();
  const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(member.id) as { t: number }).t;
  const u = { id: member.id, role: "member" as const, tenantId: t };
  for (const engine of ["opencode", "cursor"]) assert.equal(createAgent(db, u, { name: `a-${engine}`, engine, prompt: "p" }).engine, engine);
  assert.throws(() => createAgent(db, u, { name: "bad", engine: "gemini", prompt: "p" }));
  assert.throws(() => db.prepare("INSERT INTO provider_defaults (engine, updated_at) VALUES ('gemini', 1)").run());
});

test("engines: model lists and env overrides per engine", () => {
  const m = allModels({});
  assert.ok(m.opencode.every((x) => x.includes("/")), "OpenCode models are provider/model");
  assert.ok(m.cursor.includes("auto") && m.cursor.includes("claude-sonnet-5-5"));
  assert.deepEqual(allModels({ COBRA_OPENCODE_MODELS: "openai/x", COBRA_CURSOR_MODELS: "c1,c2" }).cursor, ["c1", "c2"]);
  assert.deepEqual(allModels({ COBRA_OPENCODE_MODELS: "openai/x" }).opencode, ["openai/x"]);
  assert.deepEqual(modelArgs("opencode", "openai/gpt-5.5"), ["-m", "openai/gpt-5.5"]);
  assert.deepEqual(modelArgs("cursor", "auto"), ["--model", "auto"]);
});

test("engines: tiers per engine; Cursor has none (400)", () => {
  assert.deepEqual(effortArgs("opencode", "high"), ["--variant", "high"]);
  assert.throws(() => effortArgs("cursor", "low"));
  assert.deepEqual(effortArgs("cursor", null), []);
  const { db, admin } = setup();
  assert.throws(() => setProviderDefaults(db, admin, "cursor", { effort: "low" }, 1, {}), is(400));
  assert.deepEqual(setProviderDefaults(db, admin, "cursor", { model: "auto" }, 1, {}), { model: "auto", effort: null });
  assert.deepEqual(setProviderDefaults(db, admin, "opencode", { model: "openai/gpt-5.5", effort: "low" }, 1, {}), { model: "openai/gpt-5.5", effort: "low" });
  assert.throws(() => setProviderDefaults(db, admin, "opencode", { model: "gpt-5.5" }, 1, {}), is(400));
  assert.equal(listProviders(db, {}).find((p) => p.engine === "cursor")!.tiers.length, 0);
});

test("engines: workflow schema accepts opencode/cursor engines", () => {
  const wf = (engine: string, driver: string) => ({ name: "t", version: 1, engine, governance: { approvers: ["admin"] }, steps: [{ id: "a", uses: "agent", with: { driver, prompt: "hi" } }] });
  for (const e of ["opencode", "cursor"]) {
    const r = WorkflowSchema.safeParse(wf(e, e));
    assert.ok(r.success || !r.error.issues.some((i) => String(i.path).includes("engine") || String(i.path).includes("driver")), JSON.stringify(r.error?.issues));
  }
  const bad = WorkflowSchema.safeParse(wf("gemini", "gemini"));
  assert.ok(!bad.success && bad.error.issues.some((i) => i.path.includes("engine")));
});

test("engines: Cursor API key is encrypted, never returned, admin-only, redacted list", () => {
  const { db, admin, lead, member } = setup();
  assert.equal(providerSecretStatus(db, "cursor")!.set, false);
  assert.equal(providerSecretStatus(db, "codex"), null);
  assert.throws(() => setProviderSecret(db, member, "cursor", "key_abcdefgh123", KEY), is(403));
  assert.throws(() => setProviderSecret(db, lead, "cursor", "key_abcdefgh123", KEY), is(403));
  assert.throws(() => setProviderSecret(db, admin, "codex", "key_abcdefgh123", KEY), is(400));
  assert.throws(() => setProviderSecret(db, admin, "cursor", "short", KEY), is(400));
  const v = setProviderSecret(db, admin, "cursor", "key_abcdefgh123", KEY, 5);
  assert.equal(v.set, true);
  assert.ok(!JSON.stringify(v).includes("key_abcdefgh123"));
  const raw = (db.prepare("SELECT value_enc FROM provider_secrets").get() as { value_enc: string }).value_enc;
  assert.ok(!raw.includes("key_abcdefgh123"));
  assert.equal(getProviderSecret(db, "cursor", KEY), "key_abcdefgh123");
  assert.deepEqual(providerSecretValues(db, KEY), ["key_abcdefgh123"]);
  assert.equal(setProviderSecret(db, admin, "cursor", null, KEY).set, false);
  assert.equal(getProviderSecret(db, "cursor", KEY), undefined);
});

test("engines: runner flags for opencode and cursor; cursor without a key fails clearly", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-eng-"));
  const fake = path.join(tmp, "fake"), argf = path.join(tmp, "args"), envf = path.join(tmp, "env");
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${argf}\necho "KEY=$CURSOR_API_KEY XDG=$XDG_DATA_HOME" > ${envf}\n[ -n "$XDG_DATA_HOME" ] && ls "$XDG_DATA_HOME/opencode" >> ${envf}\nexit 0\n`); chmodSync(fake, 0o755);
  const codexAuth = JSON.stringify({ tokens: { access_token: `h.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.s`, account_id: "acc", refresh_token: "NEVER" } });
  let key: string | undefined;
  const run = localRunner({ root: path.join(tmp, "ws"), resolveSecret: (n) => (n === "CODEX_AUTH_JSON" ? codexAuth : undefined), checkRepo: () => null, opencodeBin: fake, cursorBin: fake,
    providerSecret: () => key, providerDefaults: (d) => (d === "opencode" ? { model: "openai/gpt-5.5", effort: "low" } : { model: null, effort: "high" }) });
  const prevHome = process.env.HOME; process.env.HOME = tmp; // no ~/.codex here: falls back to the CODEX_AUTH_JSON secret
  try {
    const go = (driver: "opencode" | "cursor") => run({ runId: `r_${driver}_${Date.now()}`, driver, with: { prompt: "hi" }, secrets: {}, signal: new AbortController().signal, log: () => {} });
    const r = await go("opencode");
    assert.deepEqual(readFileSync(argf, "utf8").trim().split("\n"), ["run", "-m", "openai/gpt-5.5", "--variant", "low", "--auto", "hi"]);
    assert.match(readFileSync(envf, "utf8"), /auth\.json/);
    assert.ok(!existsSync(path.join(String(r.workspace), ".git", "cobra-opencode")), "opencode auth removed after the run");
    await assert.rejects(go("cursor"), /CURSOR_API_KEY/);
    key = "cur_secret_123456";
    await go("cursor");
    assert.deepEqual(readFileSync(argf, "utf8").trim().split("\n"), ["-p", "hi", "--output-format", "text", "--force", "--trust"], "no effort flag for cursor");
    assert.match(readFileSync(envf, "utf8"), /KEY=cur_secret_123456/);
  } finally { process.env.HOME = prevHome; }
  const a = opencodeAuthFromCodex(codexAuth)!;
  assert.ok(!JSON.stringify(a.auth).includes("NEVER"), "Codex refresh token is never copied");
  assert.equal(a.expires, 4102444800000);
});
