// Basic local agent runner: a per-run scratch workspace (COBRA_WORKSPACES_DIR,
// default /var/lib/cobra/workspaces/<run-id>), the chosen CLI run headless as the
// service user with a timeout, output streamed into the step log. With GITHUB_TOKEN
// and a team-registered repo it clones the repo and pushes changes to cobra/<run-id>
// (never the default branch, never --force); otherwise it uses an empty scratch repo.
// Pure Node (no Next imports) so tests can drive it with fake binaries.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { AgentRunner, RepoCheck } from "./handlers";

type Env = Record<string, string | undefined>;

export type LocalRunnerOptions = {
  root?: string;
  resolveSecret: (name: string) => string | undefined;
  checkRepo: RepoCheck;
  defaultBranch?: (repo: string) => string | null | undefined;
  claudeBin?: string;
  codexBin?: string;
  /** Value for codex --sandbox; empty means --dangerously-bypass-approvals-and-sandbox (default; see COBRA_CODEX_SANDBOX). */
  codexSandbox?: string;
  gitBin?: string;
  /** Clone URL base (tests point this at a local directory). */
  remoteBase?: string;
  defaultTimeoutMs?: number;
};

export const workspacesDir = () => process.env.COBRA_WORKSPACES_DIR || "/var/lib/cobra/workspaces";

function run(cmd: string, args: string[], o: { cwd: string; env: Env; signal: AbortSignal; log: (s: string) => void; timeoutMs?: number }): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    const on = (d: Buffer) => { const s = d.toString(); out += s; o.log(s); };
    child.stdout.on("data", on); child.stderr.on("data", on);
    // Kill the whole process group (the CLI's own children too).
    const kill = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); } };
    o.signal.addEventListener("abort", kill, { once: true });
    const t = o.timeoutMs ? setTimeout(() => { o.log(`\n[cobra] ${path.basename(cmd)} timed out after ${o.timeoutMs! / 1000}s; stopping\n`); kill(); }, o.timeoutMs) : undefined;
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => { clearTimeout(t); o.signal.removeEventListener("abort", kill); resolve({ code: code ?? -1, out }); });
  });
}

export function localRunner(opts: LocalRunnerOptions): AgentRunner {
  return async ({ runId, driver, with: w, signal, timeoutMs, log }) => {
    if (!/^[\w-]+$/.test(runId)) throw new Error("invalid run id");
    const root = opts.root ?? workspacesDir();
    const dir = path.join(root, runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const note = (s: string) => log(`[cobra] ${s}\n`);
    const base: Env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" };
    const git = opts.gitBin ?? "git";
    const token = opts.resolveSecret("GITHUB_TOKEN");
    // The token reaches git only through env-based config (never argv or the remote URL).
    const gitEnv: Env = token
      ? { ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }
      : base;
    const g = async (args: string[], cwd = dir) => {
      const r = await run(git, args, { cwd, env: gitEnv, signal, log: () => {} });
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.trim().slice(-400)}`);
      return r.out;
    };
    const repo = typeof w.repo === "string" ? w.repo.trim() : "";
    const branch = `cobra/${runId}`;
    let cloned = false;
    note(`workspace ${dir}`);
    if (repo && !token) note(`GITHUB_TOKEN is not set, so ${repo} is not cloned; running in an empty scratch repo`);
    else if (repo) {
      const denied = opts.checkRepo(repo);
      if (denied) throw new Error(denied);
      const def = opts.defaultBranch?.(repo) ?? undefined;
      note(`cloning ${repo}${def ? ` (${def})` : ""}`);
      await g(["clone", "--depth", "1", ...(def ? ["--branch", def] : []), `${opts.remoteBase ?? "https://github.com"}/${repo}.git`, "."]);
      cloned = true;
    } else note("no repo selected; running in an empty scratch repo");
    if (!cloned) await g(["init", "-q"]);
    await g(["checkout", "-q", "-b", branch]);

    const prompt = String(w.prompt ?? "").trim();
    if (!prompt) throw new Error("the run has no prompt");
    const env: Env = { ...base };
    const lastFile = path.join(dir, ".git", "cobra-last-message.txt");
    let cmd: string, args: string[];
    if (driver === "codex") {
      cmd = opts.codexBin ?? "codex";
      // Codex's own sandbox (bubblewrap/landlock) cannot write on hosts without user namespaces, so by
      // default it runs unsandboxed like Claude's --dangerously-skip-permissions: the run is already
      // confined to its own throwaway clone. COBRA_CODEX_SANDBOX=workspace-write (etc.) opts back in.
      const sandbox = (opts.codexSandbox ?? process.env.COBRA_CODEX_SANDBOX ?? "").trim();
      const mode = sandbox ? ["--sandbox", sandbox] : ["--dangerously-bypass-approvals-and-sandbox"];
      args = ["exec", "--skip-git-repo-check", ...mode, "--output-last-message", lastFile, prompt];
    } else {
      const oauth = opts.resolveSecret("CLAUDE_CODE_OAUTH_TOKEN");
      if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
      const key = opts.resolveSecret("ANTHROPIC_API_KEY");
      if (!oauth && key) env.ANTHROPIC_API_KEY = key;
      cmd = opts.claudeBin ?? "claude";
      args = ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "text"];
    }
    note(`running ${driver} headless`);
    const limit = timeoutMs ?? opts.defaultTimeoutMs ?? 10 * 60_000;
    const r = await run(cmd, args, { cwd: dir, env, signal, log, timeoutMs: limit });
    if (r.code !== 0) throw new Error(`${driver} exited with code ${r.code}`);

    await g(["add", "-A"]);
    const files = (await g(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
    let pushed = false;
    if (files.length) {
      await g(["-c", "user.name=Cobra", "-c", "user.email=cobra@localhost", "commit", "-q", "-m", `cobra: ${driver} run ${runId}`]);
      note(`committed ${files.length} file(s): ${files.join(", ")}`);
      if (cloned) { await g(["push", "-q", "origin", `${branch}:refs/heads/${branch}`]); pushed = true; note(`pushed ${branch} to ${repo}`); }
      else note("not pushed (no clone)");
    } else note("no file changes");
    const summary = existsSync(lastFile) ? readFileSync(lastFile, "utf8").trim() : r.out.trim().slice(-2000);
    return { driver, workspace: dir, branch, pushed, files: files.join(","), summary };
  };
}
