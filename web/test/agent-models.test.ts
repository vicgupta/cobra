// Job 23: per-agent model (options per engine, validation, hash, flags passed to the CLI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { checkTeamRepo } from "../lib/repos";
import { AgentError, agentHash, createAgent, updateAgent } from "../lib/agents";
import { checkModel, modelArgs, modelsFor } from "../lib/agent-models";
import { builtinHandlers } from "../lib/workflows/handlers";
import { localRunner } from "../lib/workflows/local-runner";
import { getRunDetail } from "../lib/workflows/runner";
import type { Actor } from "../lib/workflows/store";
import { runAgent, type RunDeps } from "../lib/workflows/service";

function setup() {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "m@a.com", tenant: "a", tenantName: "a", role: "member", password: "pw-1234567890" });
  const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
  return { db, u: { id, email: "m@a.com", role: "member", tenantId: t } as Actor };
}

test("models: options per engine, env override, validation", () => {
  assert.ok(modelsFor("claude-code", {}).includes("haiku"));
  assert.ok(modelsFor("codex", {}).includes("gpt-6-luna"));
  assert.ok(!modelsFor("codex", {}).includes("haiku"));
  assert.deepEqual(modelsFor("codex", { COBRA_CODEX_MODELS: " a1, b2 ,a1,bad id" }), ["a1", "b2"]);
  assert.equal(checkModel("claude-code", "default"), null);
  assert.equal(checkModel("codex", ""), null);
  assert.equal(checkModel("codex", "gpt-6-luna"), "gpt-6-luna");
  assert.throws(() => checkModel("codex", "haiku"), /not available for codex/);
  assert.throws(() => checkModel("claude-code", "gpt-6-luna"), /not available/);
  assert.deepEqual(modelArgs("claude-code", "haiku"), ["--model", "haiku"]);
  assert.deepEqual(modelArgs("codex", "gpt-6-luna"), ["-m", "gpt-6-luna"]);
  assert.deepEqual(modelArgs("codex", null), []);
  assert.throws(() => modelArgs("codex", "--evil x"));
});

test("agents: model stored, 400 when not allowed for the engine, hash changes with model (unchanged when default)", () => {
  const { db, u } = setup();
  const d = createAgent(db, u, { name: "a1", engine: "codex", prompt: "p" });
  assert.equal(d.model, null);
  assert.equal(d.contentHash, agentHash("codex", "p"), "default keeps the pre-Job-23 hash");
  const m = updateAgent(db, u, "a1", { model: "gpt-6-luna" });
  assert.equal(m.model, "gpt-6-luna");
  assert.notEqual(m.contentHash, d.contentHash);
  assert.notEqual(updateAgent(db, u, "a1", { model: "gpt-6-sol" }).contentHash, m.contentHash);
  assert.throws(() => createAgent(db, u, { name: "a2", engine: "codex", prompt: "p", model: "haiku" }), (e) => e instanceof AgentError && e.status === 400);
  assert.throws(() => updateAgent(db, u, "a1", { model: "opus" }), (e) => e instanceof AgentError && e.status === 400);
  // switching engine without a model resets to default
  const c = updateAgent(db, u, "a1", { engine: "claude-code" });
  assert.equal(c.model, null);
  assert.equal(updateAgent(db, u, "a1", { model: "default" }).model, null);
});

test("agents: model reaches the run header and the CLI flags", async () => {
  const { db, u } = setup();
  const ag = createAgent(db, u, { name: "cheap", engine: "claude-code", prompt: "p", model: "haiku" });
  const deps: RunDeps = { handlers: builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, u.tenantId, r) }), resolveSecret: () => undefined, redact: () => [] };
  const r = runAgent(db, u, "cheap", { mode: "simulated" }, deps);
  await r.run!.done;
  const out = getRunDetail(db, r.run!.id)!.events.find((e) => e.stepId === "agent" && e.status === "succeeded")!.output!;
  assert.match(out, new RegExp(`\\[agent\\] cheap @ ${ag.contentHash.slice(0, 12)} \\(claude-code, haiku, simulated\\)`));

  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-model-"));
  const fake = path.join(tmp, "fake"), argf = path.join(tmp, "args");
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${argf}\n`); chmodSync(fake, 0o755);
  const run = localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null, claudeBin: fake, codexBin: fake });
  const go = (driver: "claude-code" | "codex", model?: string) => run({ runId: `r_${driver}_${model ?? "d"}`, driver, with: { prompt: "hi", ...(model ? { model } : {}) }, secrets: {}, signal: new AbortController().signal, log: () => {} });
  await go("claude-code", "haiku");
  assert.match(readFileSync(argf, "utf8"), /^--model\nhaiku$/m);
  await go("codex", "gpt-6-luna");
  const a = readFileSync(argf, "utf8").split("\n");
  assert.equal(a[a.indexOf("-m") + 1], "gpt-6-luna");
  await go("codex");
  assert.ok(!readFileSync(argf, "utf8").split("\n").includes("-m"), "default: no flag");
});
