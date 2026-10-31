// Issue-to-PR: agents (codex) often commit on their own branch; Cobra must push those commits to cobra/<run-id>
// (not report "no file changes"), and keep partial work when the agent is stopped (timeout, memory limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { github } from "../lib/workflows/handlers";
import { localRunner } from "../lib/workflows/local-runner";

function fixture(agentScript: string) {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-own-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  const seed = path.join(tmp, "seed"); execFileSync("mkdir", ["-p", seed, path.join(tmp, "remote/owner")]);
  git(seed, "init", "-q", "-b", "main"); writeFileSync(path.join(seed, "README.md"), "hi\n");
  git(seed, "add", "."); git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const remote = path.join(tmp, "remote/owner/app.git");
  git(tmp, "clone", "-q", "--bare", seed, remote);
  const fake = path.join(tmp, "fake-agent"); writeFileSync(fake, agentScript); chmodSync(fake, 0o755);
  const runner = localRunner({ root: path.join(tmp, "ws"), resolveSecret: (n) => (n === "GITHUB_TOKEN" ? "tok" : undefined), checkRepo: () => null,
    defaultBranch: () => "main", claudeBin: fake, remoteBase: `file://${tmp}/remote` });
  return { git, remote, runner };
}
const SELF_COMMIT = "#!/bin/sh\ngit checkout -q -b amf/issue-7\necho fix > FIX.md\ngit add FIX.md\ngit -c user.name=a -c user.email=a@a commit -qm 'fix: #7'\necho done\n";

test("agent commits on its own branch: Cobra pushes HEAD to cobra/<run-id>", async () => {
  const { git, remote, runner } = fixture(SELF_COMMIT);
  const o = await runner({ runId: "run_own", driver: "claude-code", with: { repo: "owner/app", prompt: "fix" }, secrets: {}, signal: new AbortController().signal, log: () => {} });
  assert.equal(o.pushed, true);
  assert.equal(o.files, "FIX.md");
  assert.match(git(remote, "log", "--format=%s", "cobra/run_own"), /fix: #7/);
});

test("agent stopped after committing: partial work is pushed and the error says so", async () => {
  const { git, remote, runner } = fixture("#!/bin/sh\necho wip > WIP.md\nexit 1\n");
  await assert.rejects(runner({ runId: "run_dead", driver: "claude-code", with: { repo: "owner/app", prompt: "fix" }, secrets: {}, signal: new AbortController().signal, log: () => {} }),
    /exited with code 1; partial work pushed to cobra\/run_dead/);
  assert.match(git(remote, "ls-tree", "-r", "--name-only", "cobra/run_dead"), /WIP\.md/);
  assert.match(git(remote, "log", "-1", "--format=%s", "cobra/run_dead"), /partial/);
});

test("agent fails with no changes: plain error, nothing pushed", async () => {
  const { git, remote, runner } = fixture("#!/bin/sh\nexit 1\n");
  await assert.rejects(runner({ runId: "run_none", driver: "claude-code", with: { repo: "owner/app", prompt: "x" }, secrets: {}, signal: new AbortController().signal, log: () => {} }),
    (e: Error) => e.message === "claude-code exited with code 1");
  assert.doesNotMatch(git(remote, "branch"), /cobra\/run_none/);
});

test("pr_from_issue opens the PR when the agent committed itself", async () => {
  const { runner } = fixture(SELF_COMMIT);
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = String(url).replace("https://api.github.com/repos/owner/app", "");
    calls.push({ method: String(init.method), url: u, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const data = u === "/issues/7" ? { title: "Fix it", body: "please" } : u === "" ? { default_branch: "main" } : u === "/pulls" ? { number: 9, html_url: "https://x/pull/9", head: { sha: "abc" } } : {};
    return new Response(JSON.stringify(data), { status: u === "/pulls" ? 201 : 200 });
  }) as typeof fetch;
  const h = github(fetchImpl, () => null, () => "tok", { agentRunner: runner });
  const out = await h({ runId: "run_pr", step: { id: "s", uses: "github", with: {}, outputs: {} } as never, secrets: {}, signal: new AbortController().signal, log: () => {},
    with: { action: "pr_from_issue", repo: "owner/app", issue: 7, mode: "real" } }) as Record<string, unknown>;
  const pr = calls.find((c) => c.url === "/pulls");
  assert.ok(pr, "a PR was requested");
  assert.equal(pr!.body!.head, "cobra/run_pr");
  assert.equal(Number(out.number), 9);
});
