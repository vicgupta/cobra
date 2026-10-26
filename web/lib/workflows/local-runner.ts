// Basic local agent runner: a per-run scratch workspace (COBRA_WORKSPACES_DIR,
// default /home/cobra/workspaces/<run-id>), the chosen CLI run headless as the
// service user with a timeout, output streamed into the step log. With GITHUB_TOKEN
// and a team-registered repo it clones the repo and pushes changes to cobra/<run-id>
// (never the default branch, never --force); otherwise it uses an empty scratch repo.
// Pure Node (no Next imports) so tests can drive it with fake binaries.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentRunner, RepoCheck } from "./handlers";
import { modelArgs } from "../agent-models";
import { effortArgs, type ProviderDefaults } from "../providers";
import type { Engine } from "../engines";
import { usageCollector, type Usage } from "../usage";

type Env = Record<string, string | undefined>;

export type LocalRunnerOptions = {
  root?: string;
  resolveSecret: (name: string) => string | undefined;
  checkRepo: RepoCheck;
  defaultBranch?: (repo: string) => string | null | undefined;
  /** The single per-repo GitHub token resolver (Job 20): the repo's PAT when set, else GITHUB_TOKEN.
   *  When omitted (tests), GITHUB_TOKEN from resolveSecret is used. */
  githubToken?: (repo: string) => string | undefined;
  claudeBin?: string;
  codexBin?: string;
  opencodeBin?: string;
  cursorBin?: string;
  /** Decrypted Settings > Providers secret for an engine (Cursor: CURSOR_API_KEY). */
  providerSecret?: (engine: Engine) => string | undefined;
  /** Value for codex --sandbox; empty means --dangerously-bypass-approvals-and-sandbox (default; see COBRA_CODEX_SANDBOX). */
  codexSandbox?: string;
  gitBin?: string;
  /** Clone URL base (tests point this at a local directory). */
  remoteBase?: string;
  defaultTimeoutMs?: number;
  /** Settings > Providers defaults, read at run time: model when the agent has none, and the effort tier. */
  providerDefaults?: (driver: Engine) => ProviderDefaults;
  /** Usage parsed from the engine's JSON output at the end of the agent step (display only). */
  onUsage?: (runKey: string, usage: Usage) => void;
};

export const workspacesDir = () => process.env.COBRA_WORKSPACES_DIR || "/home/cobra/workspaces";

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

/** OpenCode reuses Codex's ChatGPT login: build OpenCode's openai OAuth entry from the Codex auth.json
 *  (the live ~/.codex/auth.json, else the CODEX_AUTH_JSON secret). The refresh token is deliberately
 *  left out so OpenCode can never rotate (and so invalidate) Codex's refresh token. Exported for tests. */
export function opencodeAuthFromCodex(raw: string | undefined): { auth: Record<string, unknown>; expires: number } | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { tokens?: { access_token?: string; account_id?: string } };
    const access = j.tokens?.access_token;
    if (!access) return null;
    let expires = 0;
    try { expires = (JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString()) as { exp?: number }).exp! * 1000 || 0; } catch { /* opaque token */ }
    return { auth: { openai: { type: "oauth", access, refresh: "", expires, ...(j.tokens?.account_id ? { accountId: j.tokens.account_id } : {}) } }, expires };
  } catch { return null; }
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
    const repo = typeof w.repo === "string" ? w.repo.trim() : "";
    const token = repo ? (opts.githubToken ? opts.githubToken(repo) : opts.resolveSecret("GITHUB_TOKEN")) : undefined;
    // The token reaches git only through env-based config (never argv or the remote URL).
    const gitEnv: Env = token
      ? { ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }
      : base;
    const g = async (args: string[], cwd = dir) => {
      const r = await run(git, args, { cwd, env: gitEnv, signal, log: () => {} });
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.trim().slice(-400)}`);
      return r.out;
    };
    const branch = `cobra/${runId}`;
    let cloned = false;
    note(`workspace ${dir}`);
    if (repo && !token) note(`no GitHub token (repo PAT or GITHUB_TOKEN) is set, so ${repo} is not cloned; running in an empty scratch repo`);
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
    // The agent gets exactly one GitHub token, the same one used for the clone: the repo's PAT when set,
    // else GITHUB_TOKEN; none without a cloned repo. git inside the workspace authenticates via gitEnv.
    const env: Env = cloned && token ? { ...gitEnv, GH_TOKEN: token, GITHUB_TOKEN: token } : { ...base };
    const ghNote = cloned && token ? `\n\n[Cobra] GitHub access for ${repo} is in $GH_TOKEN (also $GITHUB_TOKEN). If the gh CLI is not installed, call the GitHub REST API (https://api.github.com) with curl and "Authorization: Bearer $GH_TOKEN". Never print the token.` : "";
    const lastFile = path.join(dir, ".git", "cobra-last-message.txt");
    const pd = opts.providerDefaults?.(driver) ?? { model: null, effort: null };
    const own = typeof w.model === "string" && w.model.trim() ? w.model.trim() : null;
    const model = own ?? pd.model;
    const effort = driver === "cursor" ? null : pd.effort;
    let cmd: string, args: string[];
    let cleanup = () => {};
    if (driver === "opencode") {
      cmd = opts.opencodeBin ?? "opencode";
      // Isolated OpenCode config/data under .git (never committed), removed after the run.
      const oc = path.join(dir, ".git", "cobra-opencode");
      for (const k of ["data", "config", "state", "cache"]) mkdirSync(path.join(oc, k), { recursive: true, mode: 0o700 });
      Object.assign(env, { XDG_DATA_HOME: path.join(oc, "data"), XDG_CONFIG_HOME: path.join(oc, "config"), XDG_STATE_HOME: path.join(oc, "state"), XDG_CACHE_HOME: path.join(oc, "cache") });
      const home = process.env.HOME ?? "";
      const live = home && existsSync(path.join(home, ".codex", "auth.json")) ? readFileSync(path.join(home, ".codex", "auth.json"), "utf8") : undefined;
      const a = opencodeAuthFromCodex(live) ?? opencodeAuthFromCodex(opts.resolveSecret("CODEX_AUTH_JSON"));
      if (a) {
        mkdirSync(path.join(oc, "data", "opencode"), { recursive: true, mode: 0o700 });
        writeFileSync(path.join(oc, "data", "opencode", "auth.json"), JSON.stringify(a.auth), { mode: 0o600 });
        note(`opencode: using the Codex ChatGPT login for openai/* models${a.expires && a.expires < Date.now() ? " (its access token has expired; run a Codex job or re-login to refresh it)" : ""}`);
      }
      const ak = opts.resolveSecret("ANTHROPIC_API_KEY");
      if (ak) env.ANTHROPIC_API_KEY = ak;
      const ok = opts.resolveSecret("CODEX_API_KEY");
      if (ok) env.OPENAI_API_KEY = ok;
      if (!a && !ak && !ok) note("opencode: no credentials found (Codex ChatGPT login, ANTHROPIC_API_KEY or CODEX_API_KEY)");
      cleanup = () => { try { rmSync(oc, { recursive: true, force: true }); } catch { /* best effort */ } };
      args = ["run", ...modelArgs("opencode", model), ...effortArgs("opencode", effort), "--auto", prompt + ghNote];
    } else if (driver === "cursor") {
      cmd = opts.cursorBin ?? "cursor-agent";
      const key = opts.providerSecret?.("cursor") ?? opts.resolveSecret("CURSOR_API_KEY");
      if (!key) throw new Error("Cursor has no API key: an admin sets CURSOR_API_KEY in Settings > Providers (Cursor row)");
      env.CURSOR_API_KEY = key;
      if (effort) note("cursor: effort tiers are not supported; ignoring the effort default");
      args = ["-p", prompt + ghNote, "--output-format", "text", ...modelArgs("cursor", model), "--force", "--trust"];
    } else if (driver === "codex") {
      cmd = opts.codexBin ?? "codex";
      // Codex's own sandbox (bubblewrap/landlock) cannot write on hosts without user namespaces, so by
      // default it runs unsandboxed like Claude's --dangerously-skip-permissions: the run is already
      // confined to its own throwaway clone. COBRA_CODEX_SANDBOX=workspace-write (etc.) opts back in.
      const sandbox = (opts.codexSandbox ?? process.env.COBRA_CODEX_SANDBOX ?? "").trim();
      const mode = sandbox ? ["--sandbox", sandbox] : ["--dangerously-bypass-approvals-and-sandbox"];
      args = ["exec", "--skip-git-repo-check", ...modelArgs("codex", model), ...effortArgs("codex", effort), ...mode, "--json", "--output-last-message", lastFile, prompt + ghNote];
    } else {
      const oauth = opts.resolveSecret("CLAUDE_CODE_OAUTH_TOKEN");
      if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
      const key = opts.resolveSecret("ANTHROPIC_API_KEY");
      if (!oauth && key) env.ANTHROPIC_API_KEY = key;
      cmd = opts.claudeBin ?? "claude";
      args = ["-p", prompt + ghNote, ...modelArgs("claude-code", model), ...effortArgs("claude-code", effort), "--dangerously-skip-permissions", "--output-format", "json"];
    }
    note(`running ${driver} headless (model: ${model ?? "default"}${!own && model ? " (provider default)" : ""}, effort: ${effort ?? "default"})`);
    const limit = timeoutMs ?? opts.defaultTimeoutMs ?? 10 * 60_000;
    const uc = usageCollector(driver, model, log);
    let r: { code: number; out: string };
    try { r = await run(cmd, args, { cwd: dir, env, signal, log: (s) => uc.write(s), timeoutMs: limit }); } finally { cleanup(); }
    const parsed = uc.finish();
    { try { opts.onUsage?.(runId, parsed.usage ?? uc.orNull()); } catch (e) { note(`usage not recorded: ${(e as Error).message}`); } }
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
    const summary = existsSync(lastFile) ? readFileSync(lastFile, "utf8").trim() : (parsed.text || r.out).trim().slice(-2000);
    return { driver, workspace: dir, branch, pushed, files: files.join(","), summary };
  };
}
