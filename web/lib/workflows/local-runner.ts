// Basic local agent runner: a per-run scratch workspace (per team: <COBRA_TEAMS_ROOT>/<tenantId>/workspaces/<run-id>,
// root default /home/cobra; legacy COBRA_WORKSPACES_DIR without a team), the chosen CLI run headless as the
// service user with a timeout, output streamed into the step log. With GITHUB_TOKEN
// and a team-registered repo it clones the repo and pushes changes to cobra/<run-id>
// (never the default branch, never --force); otherwise it uses an empty scratch repo.
// Pure Node (no Next imports) so tests can drive it with fake binaries.
import { spawn } from "node:child_process";
import { assertTeamWorkspace, legacyWorkspacesDir, teamWorkspacesDir } from "../workspaces";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRunner, RepoCheck } from "./handlers";
import { modelArgs } from "../agent-models";
import { effortArgs, type ProviderDefaults } from "../providers";
import { isEngine, UNSUPPORTED_ENGINE, type Engine } from "../engines";
import { usageCollector, type Usage } from "../usage";

import { codexServerLogin, ENV_FALLBACK_TEAM, runAuth, type AuthMode } from "../provider-credentials";
type Env = Record<string, string | undefined>;

export type LocalRunnerOptions = {
  root?: string;
  /** The team the runs belong to: workspaces go in <COBRA_TEAMS_ROOT>/<tenantId>/workspaces/<runId>. */
  tenantId?: number;
  resolveSecret: (name: string) => string | undefined;
  checkRepo: RepoCheck;
  defaultBranch?: (repo: string) => string | null | undefined;
  /** The single per-repo GitHub token resolver (Job 20): the repo's PAT when set, else GITHUB_TOKEN.
   *  When omitted (tests), GITHUB_TOKEN from resolveSecret is used. */
  githubToken?: (repo: string) => string | undefined;
  claudeBin?: string;
  codexBin?: string;
  /** Stored (Settings > Providers) credential for an engine slot, e.g. ("claude-code", "ANTHROPIC_API_KEY").
   *  Falls back to resolveSecret(name) (the server env file) when it returns undefined, for team 1 only. */
  credential?: (engine: string, name: string) => string | undefined;
  /** Chosen auth method per engine (Settings > Providers); default "auto". */
  authMode?: (engine: Engine) => AuthMode;
  /** Whether the server has a Codex ChatGPT login (~/.codex/auth.json); default: checks $HOME. */
  codexServerLogin?: () => boolean;
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

/** Legacy shared dir (pre per-team); new runs use teamWorkspacesDir(tenantId) when the runner has a team. */
export const workspacesDir = legacyWorkspacesDir;

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
    if (!isEngine(driver)) throw new Error(`${String(driver)}: ${UNSUPPORTED_ENGINE} (MVP runs Claude Code or Codex only)`);
    const root = opts.root ?? (opts.tenantId ? teamWorkspacesDir(opts.tenantId) : workspacesDir());
    const dir = path.join(root, runId);
    if (opts.tenantId && !opts.root) assertTeamWorkspace(opts.tenantId, dir);
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
    // SOP skills: the full SOP body as a workspace file, kept out of commits via .git/info/exclude.
    if (typeof w.sop_body === "string" && w.sop_body) {
      mkdirSync(path.join(dir, ".cobra"), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, ".cobra", "SOP.md"), w.sop_body, { mode: 0o600 });
      mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
      const ex = path.join(dir, ".git", "info", "exclude");
      writeFileSync(ex, `${existsSync(ex) ? readFileSync(ex, "utf8") : ""}\n.cobra/\n`);
      note("wrote the SOP to .cobra/SOP.md (excluded from git)");
    }

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
    const effort = pd.effort;
    let cmd: string, args: string[];
    // Team isolation (Job 11): the server env file and the cobra user's CLI logins (~/.codex, ~/.claude) are a
    // fallback for team 1 only (and runners without a team, i.e. tests). Other teams use only their own rows.
    const fallback = opts.tenantId === undefined || opts.tenantId === ENV_FALLBACK_TEAM;
    const envSecret = (n: string) => (fallback ? opts.resolveSecret(n) : undefined);
    const cred = (e: string, n: string) => opts.credential?.(e, n) ?? envSecret(n);
    if (driver === "codex") {
      cmd = opts.codexBin ?? "codex";
      // Codex's own sandbox (bubblewrap/landlock) cannot write on hosts without user namespaces, so by
      // default it runs unsandboxed like Claude's --dangerously-skip-permissions: the run is already
      // confined to its own throwaway clone. COBRA_CODEX_SANDBOX=workspace-write (etc.) opts back in.
      const sandbox = (opts.codexSandbox ?? process.env.COBRA_CODEX_SANDBOX ?? "").trim();
      const mode = sandbox ? ["--sandbox", sandbox] : ["--dangerously-bypass-approvals-and-sandbox"];
      {
        const ra = runAuth("codex", opts.authMode?.("codex") ?? "auto", (n) => cred("codex", n), fallback && (opts.codexServerLogin ? opts.codexServerLogin() : codexServerLogin()), fallback);
        for (const k of ra.unset) delete env[k];
        Object.assign(env, ra.env);
        note(ra.note);
      }
      args = ["exec", "--skip-git-repo-check", ...modelArgs("codex", model), ...effortArgs("codex", effort), ...mode, "--json", "--output-last-message", lastFile, prompt + ghNote];
    } else {
      {
        const ra = runAuth("claude-code", opts.authMode?.("claude-code") ?? "auto", (n) => cred("claude-code", n), false, fallback);
        for (const k of ra.unset) delete env[k];
        Object.assign(env, ra.env);
        note(ra.note);
      }
      cmd = opts.claudeBin ?? "claude";
      args = ["-p", prompt + ghNote, ...modelArgs("claude-code", model), ...effortArgs("claude-code", effort), "--dangerously-skip-permissions", "--output-format", "json"];
    }
    note(`running ${driver} headless (model: ${model ?? "default"}${!own && model ? " (provider default)" : ""}, effort: ${effort ?? "default"})`);
    const limit = timeoutMs ?? opts.defaultTimeoutMs ?? 10 * 60_000;
    const uc = usageCollector(driver, model, log);
    let r: { code: number; out: string };
    try { r = await run(cmd, args, { cwd: dir, env, signal, log: (s) => uc.write(s), timeoutMs: limit }); } finally { /* nothing to clean up */ }
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
