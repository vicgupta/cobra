// OpenCode as its own provider (OpenCode Console / Zen, opencode/<model>): its own encrypted, admin-only,
// audited OPENCODE_API_KEY; picker ids; runner wiring independent of OpenRouter. No external calls (fake CLI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { checkModel, isFreeOpenCodeModel, modelArgs, modelsFor, OPENCODE_ZEN_MODELS } from "../lib/agent-models";
import { getProviderSecret, listProviderAudit, providerSecretStatus, providerSecretValues, setProviderSecret } from "../lib/providers";
import { openRouterStatus } from "../lib/openrouter";
import { localRunner } from "../lib/workflows/local-runner";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OC = "oc-zen-TESTONLY0123456789";
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "member") => ({ id: createUser(db, { email, tenant: "a", tenantName: "a", role, password: "pw-1234567890" }), email, role });
  return { db, admin: mk("admin@a.com", "admin"), member: mk("m@a.com", "member") };
}

test("opencode key: encrypted, admin-only, never returned, audited, separate from OpenRouter", () => {
  const { db, admin, member } = setup();
  assert.throws(() => setProviderSecret(db, member, "opencode", OC, KEY), (e) => e instanceof CollabError && e.status === 403);
  const v = setProviderSecret(db, admin, "opencode", OC, KEY);
  assert.equal(v.name, "OPENCODE_API_KEY"); assert.equal(v.set, true); assert.ok(!JSON.stringify(v).includes(OC));
  const raw = db.prepare("SELECT value_enc FROM provider_secrets WHERE engine = 'opencode'").get() as { value_enc: string };
  assert.ok(!raw.value_enc.includes(OC));
  assert.equal(getProviderSecret(db, "opencode", KEY), OC);
  assert.ok(providerSecretValues(db, KEY).includes(OC), "redacted from logs");
  assert.equal(openRouterStatus(db).set, false, "OpenRouter key untouched");
  const a = listProviderAudit(db, 5)[0]; assert.equal(a.engine, "opencode"); assert.match(a.detail!, /OPENCODE_API_KEY set/); assert.ok(!JSON.stringify(a).includes(OC));
  setProviderSecret(db, admin, "opencode", null, KEY);
  assert.equal(providerSecretStatus(db, "opencode")!.set, false);
});

test("opencode models: opencode/<model> ids on the OpenCode engine only", () => {
  const m = modelsFor("opencode", {});
  for (const id of OPENCODE_ZEN_MODELS) assert.ok(m.includes(id));
  assert.ok(m.includes("openai/gpt-6.1-sol") && m.includes("openrouter/qwen/qwen3-coder"), "existing ids kept");
  assert.equal(checkModel("opencode", "opencode/kimi-k3", {}), "opencode/kimi-k3");
  assert.equal(checkModel("opencode", "opencode/some-new-model", {}), "opencode/some-new-model", "custom ids allowed");
  assert.throws(() => checkModel("codex", "opencode/gpt-6-sol", {}), /OpenCode engine/);
  assert.throws(() => checkModel("opencode", "opencode/Bad Id", {}));
  assert.deepEqual(modelArgs("opencode", "opencode/gpt-6-sol"), ["-m", "opencode/gpt-6-sol"]);
  assert.ok(isFreeOpenCodeModel("opencode/big-pickle") && isFreeOpenCodeModel("opencode/glm-5.3-flash-free") && !isFreeOpenCodeModel("opencode/gpt-6-sol"));
});

test("opencode runner: OPENCODE_API_KEY injected, no OpenRouter key, clear error without a key", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-oc-")), out = path.join(tmp, "out.txt"), fake = path.join(tmp, "fake.sh");
  writeFileSync(fake, `#!/bin/sh\n{ for a in "$@"; do echo "ARG=$a"; done; echo "OPENCODE_API_KEY=$OPENCODE_API_KEY"; echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"; } > ${out}\necho done\n`); chmodSync(fake, 0o755);
  const prevHome = process.env.HOME; process.env.HOME = path.join(tmp, "home");
  let key: string | undefined = OC, n = 0, orCalls = 0;
  const go = (model: string) => localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, opencodeBin: fake,
    providerSecret: (e) => (e === "opencode" ? key : undefined), openRouterKey: () => { orCalls++; return "sk-or-SHOULD-NOT-BE-USED"; } })(
    { runId: `r${++n}`, driver: "opencode", with: { prompt: "hi", model }, secrets: {}, signal: new AbortController().signal, log: () => {} });
  const o = () => readFileSync(out, "utf8");
  try {
    await go("opencode/gpt-6-sol");
    assert.match(o(), new RegExp(`OPENCODE_API_KEY=${OC}`)); assert.match(o(), /OPENROUTER_API_KEY=\n/); assert.match(o(), /ARG=opencode\/gpt-6-sol/);
    assert.equal(orCalls, 0, "the OpenRouter key is never read for opencode/* models");
    key = undefined;
    await assert.rejects(go("opencode/gpt-6-sol"), /OpenCode has no API key/);
    await go("opencode/big-pickle");
    assert.match(o(), /OPENCODE_API_KEY=\n/); assert.match(o(), /ARG=opencode\/big-pickle/);
  } finally { process.env.HOME = prevHome; }
});
