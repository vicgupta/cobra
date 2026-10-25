import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeValue, parseEnv, unescapeValue } from "../src/config/env-file.js";
import { readSecret } from "../src/agents/claude-code.js";

test("escape/parse round-trip", () => {
  for (const v of ['plain', 'with "quotes"', "back\\slash", "multi\nline\nvalue", '{"a":"b\\"c"}', "trailing\\"]) {
    assert.equal(unescapeValue(escapeValue(v)), v);
    assert.deepEqual(parseEnv(`# c\nK=${escapeValue(v)}\n`), { K: v });
  }
  assert.deepEqual(parseEnv('#A=\nB=raw\n  # x=1\nC=""'), { B: "raw", C: "" });
});

test("readSecret precedence: env file > process.env > FACTORY_SECRETS_JSON > localFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-"));
  const envFile = join(dir, "cobra.env");
  const local = join(dir, "local");
  writeFileSync(local, "from-local");
  const saved = { ...process.env };
  try {
    const e = { secret: "ANTHROPIC_API_KEY", localFile: local };
    process.env.COBRA_ENV_FILE = join(dir, "missing.env");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FACTORY_SECRETS_JSON;
    assert.equal(readSecret(e), "from-local");
    process.env.FACTORY_SECRETS_JSON = JSON.stringify({ ANTHROPIC_API_KEY: "from-blob" });
    assert.equal(readSecret(e), "from-blob");
    process.env.ANTHROPIC_API_KEY = "from-env";
    assert.equal(readSecret(e), "from-env");
    process.env.COBRA_ENV_FILE = envFile;
    writeFileSync(envFile, `NODE_ENV=production\nANTHROPIC_API_KEY=${escapeValue("from-file")}\n`);
    assert.equal(readSecret(e), "from-file");
    // Cleared in the file: not served stale from process.env.
    writeFileSync(envFile, "#ANTHROPIC_API_KEY=\n");
    assert.equal(readSecret(e), undefined);
    // Non-managed keys still fall through when the file lacks them.
    process.env.OTHER_SECRET = "from-env";
    assert.equal(readSecret({ secret: "OTHER_SECRET" }), "from-env");
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
