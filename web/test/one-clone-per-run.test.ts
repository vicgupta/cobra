// A multi-step (SOP skill) run clones its repo once into <root>/<runId> and every step reuses that workspace and
// branch cobra/<runId>; single-step runs are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agent } from "../lib/workflows/handlers";
import { localRunner } from "../lib/workflows/local-runner";

function fixture() {
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-1c-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  const seed = path.join(tmp, "seed"); execFileSync("mkdir", ["-p", seed, path.join(tmp, "remote/owner")]);
  git(seed, "init", "-q", "-b", "main"); writeFileSync(path.join(seed, "README.md"), "hi\n");
  git(seed, "add", "."); git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  git(tmp, "clone", "-q", "--bare", seed, path.join(tmp, "remote/owner/app.git"));
  // git wrapper that counts clones
  const calls = path.join(tmp, "git-calls.log");
  const gitBin = path.join(tmp, "git-wrap");
  writeFileSync(gitBin, `#!/bin/sh\necho "$1" >> ${calls}\nexec git "$@"\n`); chmodSync(gitBin, 0o755);
  // fake agent: step 1 writes NOTE.md; later steps record whether they can see it and append to it
  const fake = path.join(tmp, "fake-claude");
  writeFileSync(fake, `#!/bin/sh\nif [ -f NOTE.md ]; then echo "saw:$(cat NOTE.md)"; echo more >> NOTE.md; else echo first > NOTE.md; echo "fresh"; fi\nls .cobra 2>/dev/null; true\n`); chmodSync(fake, 0o755);
  const runner = localRunner({ root: path.join(tmp, "ws"), resolveSecret: (n) => (n === "GITHUB_TOKEN" ? "tok" : undefined), checkRepo: (r) => (r === "owner/app" ? null : "not registered"),
    defaultBranch: () => "main", claudeBin: fake, gitBin, remoteBase: `file://${tmp}/remote` });
  const clones = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((l) => l === "clone").length : 0);
  return { tmp, git, runner, clones };
}

test("skill run: N steps share one clone, one workspace dir and one branch; files carry over", async () => {
  const { tmp, git, runner, clones } = fixture();
  const h = agent(runner);
  const step = { id: "s", uses: "agent", with: {}, outputs: {} } as never;
  const logs: string[] = [];
  const outs = [];
  for (const slug of ["01-plan", "02-do", "03-check"]) {
    outs.push(await h({ runId: "skr_one", stepKey: `skr_one-${slug}`, step, secrets: {}, signal: new AbortController().signal,
      with: { driver: "claude-code", mode: "live", repo: "owner/app", prompt: `step ${slug}`, sop_body: "# SOP\n" }, log: (c) => logs.push(c) }) as Record<string, unknown>);
  }
  assert.equal(clones(), 1, "exactly one clone for the run");
  assert.deepEqual(readdirSync(path.join(tmp, "ws")), ["skr_one"], "exactly one workspace dir");
  for (const o of outs) { assert.equal(o.branch, "cobra/skr_one"); assert.equal(o.workspace, path.join(tmp, "ws/skr_one")); }
  const all = logs.join("");
  assert.match(all, /fresh/); assert.match(all, /saw:first/); assert.match(all, /reusing this run's workspace/);
  assert.equal(readFileSync(path.join(tmp, "ws/skr_one/NOTE.md"), "utf8"), "first\nmore\nmore\n");
  // .cobra excluded once, never committed; commits accumulate on the pushed run branch
  const exclude = readFileSync(path.join(tmp, "ws/skr_one/.git/info/exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((l) => l === ".cobra/").length, 1);
  const remote = path.join(tmp, "remote/owner/app.git");
  const tree = git(remote, "ls-tree", "-r", "--name-only", "cobra/skr_one");
  assert.match(tree, /NOTE\.md/); assert.doesNotMatch(tree, /\.cobra/);
  assert.equal(git(remote, "rev-list", "--count", "main..cobra/skr_one").trim(), "3");
  assert.equal(outs.every((o) => o.pushed === true), true);
});

test("single-step run unchanged: own workspace <runId>, clone, cobra/<runId>", async () => {
  const { tmp, runner, clones } = fixture();
  const h = agent(runner);
  const step = { id: "s", uses: "agent", with: {}, outputs: {} } as never;
  for (const id of ["run_a", "run_b"]) {
    const o = await h({ runId: id, stepKey: id, step, secrets: {}, signal: new AbortController().signal,
      with: { driver: "claude-code", mode: "live", repo: "owner/app", prompt: "p" }, log: () => {} }) as Record<string, unknown>;
    assert.equal(o.branch, `cobra/${id}`); assert.equal(o.pushed, true);
  }
  // direct runner call without workspaceKey behaves like before too
  const o = await runner({ runId: "run_c", driver: "claude-code", with: { repo: "owner/app", prompt: "p" }, secrets: {}, signal: new AbortController().signal, log: () => {} });
  assert.equal(o.branch, "cobra/run_c");
  assert.equal(clones(), 3);
  assert.deepEqual(readdirSync(path.join(tmp, "ws")).sort(), ["run_a", "run_b", "run_c"]);
  for (const id of ["run_a", "run_b", "run_c"]) assert.equal(readFileSync(path.join(tmp, "ws", id, "NOTE.md"), "utf8"), "first\n");
});
