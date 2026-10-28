// Per-team run users: the runner sends every git/CLI step through the run launcher (fake server here, which runs
// the real launcher/stage.py as the current user), never spawns the CLIs itself when a socket is configured, and
// fails closed (production without a launcher, launcher down, or a refusal).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { localRunner } from "../lib/workflows/local-runner";
import { launchEnv, type LaunchRequest } from "../lib/workflows/launcher-client";

const STAGE = path.resolve(__dirname, "..", "..", "launcher", "stage.py");
const tmp = mkdtempSync(path.join(tmpdir(), "cobra-launch-"));
const fake = path.join(tmp, "fake-cli"), ran = path.join(tmp, "ran");
writeFileSync(fake, `#!/bin/sh\necho "ARGS=$1 TOKEN=\${CLAUDE_CODE_OAUTH_TOKEN:+set} HOME=$HOME" >> ${ran}\necho "agent output"\necho done > notes.txt\necho '{"result":"ok"}'\n`);
chmodSync(fake, 0o755);

type Fake = { sock: string; reqs: LaunchRequest[]; closed: number; close: () => Promise<void> };
function fakeLauncher(mode: "run" | "refuse" | "hang" = "run"): Promise<Fake> {
  const sock = path.join(mkdtempSync(path.join(tmpdir(), "cobra-sock-")), "l.sock");
  const f: Fake = { sock, reqs: [], closed: 0, close: async () => {} };
  const srv = net.createServer((c) => {
    let buf = "";
    c.on("close", () => f.closed++);
    c.on("data", (d) => {
      buf += d; const i = buf.indexOf("\n"); if (i < 0) return;
      const r = JSON.parse(buf.slice(0, i)) as LaunchRequest; buf = "\n"; f.reqs.push(r);
      if (mode === "refuse") return void c.end(JSON.stringify({ t: "e", error: "engine not allowed" }) + "\n");
      if (mode === "hang") return;
      const p = spawn("python3", ["-I", STAGE], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (x) => (out += x));
      p.stderr.on("data", (x) => c.write(JSON.stringify({ t: "o", d: String(x) }) + "\n"));
      p.on("close", (code) => c.end(JSON.stringify({ t: "x", code, files: JSON.parse(out || "{}").files ?? {} }) + "\n"));
      p.stdin.end(JSON.stringify({ cmd: r.engine === "git" ? "git" : fake, args: r.args, workspace: r.workspace, mkdir: r.mkdir, files: r.files, readBack: r.readBack, rmAfter: r.rmAfter,
        env: { PATH: process.env.PATH, HOME: path.join(tmp, "teamhome"), ...r.env } }));
    });
  });
  return new Promise((res) => srv.listen(sock, () => { f.close = () => new Promise((r) => srv.close(() => r())); res(f); }));
}

// Synthetic, unsigned test JWT (not a real credential), as in codex-login.test.ts.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "none" })}.${b64({ iss: "https://auth.openai.com", exp: Math.floor(Date.now() / 1000) + 9 * 86400, "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-1" } })}.c2ln`;
const teams = path.join(tmp, "teams");
process.env.COBRA_TEAMS_ROOT = teams;
const go = (o: { sock?: string; driver?: "claude-code" | "codex"; signal?: AbortSignal; sop?: string; runId?: string; log?: string[] }) =>
  localRunner({ tenantId: 2, launcherSocket: o.sock, resolveSecret: () => undefined, checkRepo: () => null, claudeBin: "/nonexistent/claude", codexBin: "/nonexistent/codex",
    credential: (_e, n) => (n === "CLAUDE_CODE_OAUTH_TOKEN" ? "oauth-secret" : n === "CODEX_ACCESS_TOKEN" ? JWT : undefined), authMode: () => "subscription", codexServerLogin: () => false })(
    { runId: o.runId ?? "run_l1", driver: o.driver ?? "claude-code", with: { prompt: "do it", ...(o.sop ? { sop_body: o.sop } : {}) }, secrets: {}, signal: o.signal ?? new AbortController().signal, log: (s) => o.log?.push(s) });

test("launcher: every step goes through it with the team workspace; tokens only in the allowlisted env", async () => {
  const f = await fakeLauncher();
  try {
    const log: string[] = [];
    const r = await go({ sock: f.sock, sop: "Be careful.", log });
    const ws = path.join(teams, "2", "workspaces", "run_l1");
    assert.equal(r.workspace, ws);
    assert.deepEqual(f.reqs.map((q) => `${q.engine} ${q.args[0]}`), ["git init", "git checkout", "claude-code -p", "git add", "git diff", "git -c"]);
    for (const q of f.reqs) { assert.equal(q.tenantId, 2); assert.equal(q.runId, "run_l1"); assert.equal(q.workspace, ws); assert.ok(!("PATH" in q.env) && !("HOME" in q.env)); }
    assert.equal(f.reqs[0].mkdir, true, "the first step creates the workspace");
    const eng = f.reqs[2];
    assert.equal(eng.env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-secret");
    assert.deepEqual(eng.files?.map((x) => x.path), [".cobra/SOP.md", ".git/info/exclude"]);
    assert.deepEqual(eng.readBack, [".git/cobra-last-message.txt"]);
    assert.ok(f.reqs.filter((q) => q.engine === "git").every((q) => !q.env.CLAUDE_CODE_OAUTH_TOKEN), "git steps never get the agent token");
    assert.match(readFileSync(ran, "utf8"), /ARGS=-p TOKEN=set HOME=.*teamhome/);
    assert.match(log.join(""), /agent output/);
    assert.equal(r.files, "notes.txt", "SOP excluded from the commit");
    assert.equal(existsSync(path.join(ws, ".cobra", "SOP.md")), true);
  } finally { await f.close(); }
});

test("launcher: codex ChatGPT login goes in as a workspace file, is read back and removed", async () => {
  const f = await fakeLauncher();
  try {
    const r = await go({ sock: f.sock, driver: "codex", runId: "run_l2" });
    const eng = f.reqs.find((q) => q.engine === "codex")!;
    assert.equal(eng.env.CODEX_HOME, path.join(String(r.workspace), ".git", "cobra-codex-home"));
    assert.deepEqual(eng.files?.map((x) => [x.path, x.mode]), [[".git/cobra-codex-home/auth.json", "600"]]);
    assert.deepEqual(eng.rmAfter, [".git/cobra-codex-home"]);
    assert.ok(eng.readBack?.includes(".git/cobra-codex-home/auth.json"));
    assert.equal(existsSync(path.join(String(r.workspace), ".git", "cobra-codex-home")), false);
  } finally { await f.close(); }
});

test("fails closed: launcher down, refusal, production without a launcher; cancel closes the connection", async () => {
  await assert.rejects(go({ sock: path.join(tmp, "missing.sock"), runId: "run_l3" }), /run launcher unavailable.*not running the step as the service user/);
  assert.equal(existsSync(path.join(teams, "2", "workspaces", "run_l3")), false, "nothing ran locally");
  const ref = await fakeLauncher("refuse");
  await assert.rejects(go({ sock: ref.sock, runId: "run_l4" }), /run launcher refused the step: engine not allowed/);
  await ref.close();
  const prev = process.env.NODE_ENV, prevSock = process.env.COBRA_LAUNCHER_SOCKET;
  (process.env as Record<string, string>).NODE_ENV = "production"; delete process.env.COBRA_LAUNCHER_SOCKET;
  try { await assert.rejects(go({ runId: "run_l5" }), /run launcher is not configured.*refusing/); } finally { (process.env as Record<string, string | undefined>).NODE_ENV = prev; if (prevSock) process.env.COBRA_LAUNCHER_SOCKET = prevSock; }
  assert.throws(() => launchEnv({ LD_PRELOAD: "x" }), /not allowed/);
  const hang = await fakeLauncher("hang"), ac = new AbortController();
  const p = go({ sock: hang.sock, runId: "run_l6", signal: ac.signal });
  await new Promise((r) => setTimeout(r, 200)); ac.abort();
  await assert.rejects(p, /git init failed/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hang.closed, 1, "cancel closes the launcher connection (which stops the unit)");
  await hang.close();
});
