// Settings > Providers: admin-only defaults, validation per provider, audit, defaults used on runs, hashes unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { agentHash, createAgent } from "../lib/agents";
import { CollabError } from "../lib/collab";
import { effortArgs, getProviderDefaults, listProviderAudit, listProviders, setProviderDefaults } from "../lib/providers";
import { localRunner } from "../lib/workflows/local-runner";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member") => ({ id: createUser(db, { email, tenant: "a", tenantName: "a", role, password: "pw-1234567890" }), email, role });
  return { db, admin: mk("admin@a.com", "admin"), lead: mk("lead@a.com", "team_lead"), member: mk("m@a.com", "member") };
}
const is = (status: number) => (e: unknown) => e instanceof CollabError && e.status === status;

test("providers: listed from code, tiers per engine (Cursor: none), no simulated provider", () => {
  const { db } = setup();
  const all = listProviders(db, {});
  assert.deepEqual(all.map((x) => x.engine), ["claude-code", "codex"]);
  const p = all;
  assert.ok(p[0].models.includes("claude-sonnet-5-5"));
  assert.ok(p[1].models.includes("gpt-6.1-sol"));
  for (const x of p) { assert.deepEqual([...x.tiers], ["low", "medium", "high"]); assert.deepEqual(x.defaults, { model: null, effort: null }); }
  assert.deepEqual(listProviders(db, { COBRA_CODEX_MODELS: "x1,x2" })[1].models, ["x1", "x2"]);
});

test("providers: only system admins can set defaults", () => {
  const { db, lead, member } = setup();
  assert.throws(() => setProviderDefaults(db, member, "codex", { effort: "high" }), is(403));
  assert.throws(() => setProviderDefaults(db, lead, "codex", { effort: "high" }), is(403));
  assert.deepEqual(getProviderDefaults(db, "codex", {}), { model: null, effort: null });
  assert.equal(listProviderAudit(db, 1).length, 0);
});

test("providers: validation of models and tiers per provider, and audit", () => {
  const { db, admin } = setup();
  assert.throws(() => setProviderDefaults(db, admin, "simulate", { effort: "high" }, 1, {}), is(404));
  assert.throws(() => setProviderDefaults(db, admin, "codex", { model: "sonnet" }, 1, {}), is(400));
  assert.throws(() => setProviderDefaults(db, admin, "claude-code", { model: "gpt-6-luna" }, 1, {}), is(400));
  assert.throws(() => setProviderDefaults(db, admin, "codex", { effort: "max" }, 1, {}), is(400));
  assert.throws(() => setProviderDefaults(db, admin, "codex", { effort: "--x" }, 1, {}), is(400));
  assert.throws(() => setProviderDefaults(db, admin, "codex", {}, 1, {}), is(400));
  assert.deepEqual(setProviderDefaults(db, admin, "claude-code", { model: "claude-sonnet-5-5", effort: "high" }, 10, {}), { model: "claude-sonnet-5-5", effort: "high" });
  assert.deepEqual(setProviderDefaults(db, admin, "codex", { model: "gpt-6-luna", effort: "low" }, 11, {}), { model: "gpt-6-luna", effort: "low" });
  assert.deepEqual(setProviderDefaults(db, admin, "codex", { effort: "medium" }, 12, {}), { model: "gpt-6-luna", effort: "medium" }, "omitted model is kept");
  setProviderDefaults(db, admin, "codex", { effort: "medium" }, 13, {}); // no-op: not audited
  assert.deepEqual(setProviderDefaults(db, admin, "codex", { model: "default", effort: null }, 14, {}), { model: null, effort: null });
  const log = listProviderAudit(db, 1);
  assert.equal(log.length, 4);
  assert.deepEqual({ ...log[0] }, { actorEmail: "admin@a.com", engine: "codex", oldModel: "gpt-6-luna", newModel: null, oldEffort: "medium", newEffort: null, detail: null, at: 14 });
  // a stored model dropped from the env list reads as default
  assert.equal(getProviderDefaults(db, "claude-code", { COBRA_CLAUDE_MODELS: "opus" }).model, null);
});

test("providers: effort flags and defaults reach the CLI; agent model wins; hashes unchanged", async () => {
  const { db, admin, member } = setup();
  assert.deepEqual(effortArgs("claude-code", "high"), ["--effort", "high"]);
  assert.deepEqual(effortArgs("codex", "low"), ["-c", 'model_reasoning_effort="low"']);
  assert.deepEqual(effortArgs("codex", null), []);
  assert.throws(() => effortArgs("claude-code", "max"));

  const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(member.id) as { t: number }).t;
  const before = createAgent(db, { id: member.id, role: "member", tenantId: t }, { name: "d", engine: "codex", prompt: "p" });
  setProviderDefaults(db, admin, "codex", { model: "gpt-6-luna", effort: "high" }, 1, {});
  setProviderDefaults(db, admin, "claude-code", { model: "claude-sonnet-5-5", effort: "medium" }, 1, {});
  const after = db.prepare("SELECT content_hash h FROM team_agents WHERE name = 'd'").get() as { h: string };
  assert.equal(after.h, before.contentHash);
  assert.equal(after.h, agentHash("codex", "p"), "Default agents keep the pre-Job-23 hash");

  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-prov-"));
  const fake = path.join(tmp, "fake"), argf = path.join(tmp, "args");
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${argf}\n`); chmodSync(fake, 0o755);
  const run = localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, claudeBin: fake, codexBin: fake, providerDefaults: (d) => getProviderDefaults(db, d, {}) });
  let logged = "";
  const go = (driver: "claude-code" | "codex", model?: string) => run({ runId: `r_${driver}_${model ?? "d"}`, driver, with: { prompt: "hi", ...(model ? { model } : {}) }, secrets: {}, signal: new AbortController().signal, log: (s) => { logged += s; } });
  const args = () => readFileSync(argf, "utf8").split("\n");
  await go("codex");
  let a = args();
  assert.equal(a[a.indexOf("-m") + 1], "gpt-6-luna");
  assert.equal(a[a.indexOf("-c") + 1], 'model_reasoning_effort="high"');
  assert.match(logged, /model: gpt-6-luna \(provider default\), effort: high/);
  await go("codex", "gpt-6-sol");
  a = args();
  assert.equal(a[a.indexOf("-m") + 1], "gpt-6-sol", "the agent's own model wins");
  await go("claude-code");
  a = args();
  assert.equal(a[a.indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.equal(a[a.indexOf("--effort") + 1], "medium");
  setProviderDefaults(db, admin, "claude-code", { model: "default", effort: "default" }, 2, {});
  await go("claude-code");
  a = args();
  assert.ok(!a.includes("--effort") && !a.includes("--model"), "defaults cleared: no flags");
});

test("Settings > Providers UI: no helper copy, Sources or Recent provider changes; audit API kept", async () => {
  const { readFileSync } = await import("node:fs");
  const v = readFileSync(new URL("../components/providers.tsx", import.meta.url), "utf8");
  const f = readFileSync(new URL("../components/provider-credentials-form.tsx", import.meta.url), "utf8");
  for (const s of ["The coding agents Cobra can run", "data-read-only-note", "data-no-subscription", "data-codex-login", 'title="Sources"', "Recent provider changes", "listProviderAudit", "AES-256-GCM"]) assert.ok(!v.includes(s), s);
  for (const s of ["Stored encrypted; never shown again", "Set in server env"]) assert.ok(!f.includes(s), s);
  assert.ok(v.includes("data-credentials-manager") && f.includes("aria-label="));
  assert.ok(v.indexOf("data-credentials-manager") < v.indexOf("data-providers>"), "summary table below credentials");
  assert.match(readFileSync(new URL("../lib/providers.ts", import.meta.url), "utf8"), /export function listProviderAudit/);
});

test("Settings > Providers redesign: one card per provider with badge, segmented auth, pills, inline replace", async () => {
  const { readFileSync } = await import("node:fs");
  const v = readFileSync(new URL("../components/providers.tsx", import.meta.url), "utf8");
  const f = readFileSync(new URL("../components/provider-credentials-form.tsx", import.meta.url), "utf8");
  for (const s of ["data-cred-provider={e}", "data-provider-connected", '"Connected"', '"Not connected"', '"From server env"', '"Not set"', "data-cred-meta", "data-primary"]) assert.ok(v.includes(s), s);
  for (const s of ['role="radiogroup"', "type=\"radio\"", "aria-expanded", "from \"./styles\"", '"Replace"', "data-confirm-delete", "disabled={busy || !value.trim()}", 'role={msg.ok ? "status" : "alert"}']) assert.ok(f.includes(s), s);
  // same APIs as before (UI only)
  assert.ok(f.includes("/api/providers/${engine}/credentials") && f.includes("/api/providers/${engine}/auth"));
});
