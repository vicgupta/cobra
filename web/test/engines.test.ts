// MVP build: Claude Code and Codex only. Rows using removed engines stay in the DB, render as unsupported, and are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { createAgent } from "../lib/agents";
import { ENGINES, engineLabel, isEngine, UNSUPPORTED_ENGINE } from "../lib/engines";
import { allModels } from "../lib/agent-models";
import { localRunner } from "../lib/workflows/local-runner";

const tid = (db: ReturnType<typeof openDb>, id: number) => (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;

test("engines: only Claude Code and Codex", () => {
  assert.deepEqual([...ENGINES], ["claude-code", "codex"]);
  for (const e of ["opencode", "cursor", "openrouter", "tinyagent", "custom:x"]) assert.ok(!isEngine(e));
  assert.deepEqual(Object.keys(allModels({})).sort(), ["claude-code", "codex"]);
  assert.match(engineLabel("opencode"), new RegExp(UNSUPPORTED_ENGINE));
});

test("engines: new agents on removed engines are refused; Claude/Codex accepted", () => {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "m@a.com", tenant: "a", tenantName: "a", role: "member", password: "pw-1234567890" });
  const u = { id, role: "member" as const, tenantId: tid(db, id) };
  for (const engine of ["claude-code", "codex"]) assert.equal(createAgent(db, u, { name: `a-${engine}`, engine, prompt: "p" }).engine, engine);
  for (const engine of ["opencode", "cursor"]) assert.throws(() => createAgent(db, u, { name: `b-${engine}`, engine, prompt: "p" }));
});

test("engines: runner refuses a removed engine with a clear message", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-eng-"));
  const run = localRunner({ root: path.join(tmp, "ws"), resolveSecret: () => undefined, checkRepo: () => null });
  await assert.rejects(run({ runId: "r_x", driver: "opencode" as never, with: { prompt: "hi" }, secrets: {}, signal: new AbortController().signal, log: () => {} }), new RegExp(UNSUPPORTED_ENGINE));
});
