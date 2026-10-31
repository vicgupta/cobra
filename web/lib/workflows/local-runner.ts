// Basic local agent runner: a per-run scratch workspace (per team: <COBRA_TEAMS_ROOT>/<tenantId>/workspaces/<run-id>,
// root default /home/cobra; legacy COBRA_WORKSPACES_DIR without a team), the chosen CLI run headless with a
// timeout, output streamed into the step log. With COBRA_LAUNCHER_SOCKET set, every git/CLI step runs through
// the root-owned run launcher as the team's own Linux user (cobra-run-<tenantId>); in production without it the
// runner refuses to run (it never falls back to running the CLIs as the service user). With GITHUB_TOKEN
// and a team-registered repo it clones the repo and pushes changes to cobra/<run-id>
// (never the default branch, never --force); otherwise it uses an empty scratch repo.
// Pure Node (no Next imports) so tests can drive it with fake binaries.
import { spawn } from "node:child_process";
import { assertTeamWorkspace, legacyWorkspacesDir, teamWorkspacesDir } from "../workspaces";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { launch, launchEnv, type LaunchEngine, type LaunchFile } from "./launcher-client";
import { buildAuthJson, refreshedLogin } from "../codex-login";
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
  /** The codex CLI refreshed the team's stored ChatGPT login during a run: save this auth.json (encrypted). */
  onCodexLoginRefresh?: (authJson: string) => void;
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
  /** Run launcher socket (default COBRA_LAUNCHER_SOCKET). Set: steps run as the team user via the launcher. */
  launcherSocket?: string;
};

type Step = { engine: LaunchEngine; cmd: string; args: string[]; env: Env; log: (s: string) => void; timeoutMs?: number;
  mkdir?: boolean; files?: LaunchFile[]; readBack?: string[]; rmAfter?: string[] };
type StepResult = { code: number; out: string; files: Record<string, string | null> };

/** Runs a step directly as this process's user (dev/tests): same workspace file semantics as the launcher's stage. */
async function directStep(dir: string, s: Step, signal: AbortSignal): Promise<StepResult> {
  if (s.mkdir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of s.files ?? []) {
    const p = path.join(dir, f.path);
    mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    (f.append ? appendFileSync : writeFileSync)(p, f.content);
    if (f.mode) chmodSync(p, parseInt(f.mode, 8) & 0o700);
  }
  try {
    const r = await run(s.cmd, s.args, { cwd: dir, env: s.env, signal, log: s.log, timeoutMs: s.timeoutMs });
    const files: Record<string, string | null> = {};
    for (const p of s.readBack ?? []) { try { files[p] = readFileSync(path.join(dir, p), "utf8"); } catch { files[p] = null; } }
    return { ...r, files };
  } finally { for (const p of s.rmAfter ?? []) rmSync(path.join(dir, p), { recursive: true, force: true }); }
}

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

/** Workspaces already cloned/initialised and on their run branch, by absolute dir: later steps of the same run
 *  reuse them (no clone/init/checkout). Module-level so it survives a runner being rebuilt per request. */
type Prepared = { cloned: boolean; branch: string; sop: boolean };
const prepared = new Map<string, Prepared>();
/** Tests only. */
export function _resetPreparedWorkspaces(): void { prepared.clear(); }

export function localRunner(opts: LocalRunnerOptions): AgentRunner {
  return async ({ runId, workspaceKey, driver, with: w, signal, timeoutMs, log }) => {
    if (!/^[\w-]+$/.test(runId)) throw new Error("invalid run id");
    const wsKey = workspaceKey ?? runId;
    if (!/^[\w-]+$/.test(wsKey)) throw new Error("invalid run id");
    if (!isEngine(driver)) throw new Error(`${String(driver)}: ${UNSUPPORTED_ENGINE} (MVP runs Claude Code or Codex only)`);
    const root = opts.root ?? (opts.tenantId ? teamWorkspacesDir(opts.tenantId) : workspacesDir());
    const dir = path.join(root, wsKey);
    if (opts.tenantId && !opts.root) assertTeamWorkspace(opts.tenantId, dir);
    const sock = opts.launcherSocket ?? process.env.COBRA_LAUNCHER_SOCKET ?? "";
    if (sock && !opts.tenantId) throw new Error("the run launcher needs a team: refusing to run");
    if (!sock && process.env.NODE_ENV === "production") throw new Error("the run launcher is not configured (COBRA_LAUNCHER_SOCKET): refusing to run agent CLIs as the service user");
    const reuse = prepared.get(dir);
    let made = !!reuse; // an existing workspace is never re-created (mkdir only on the run's first step)
    const step = async (s: Step): Promise<StepResult> => {
      const first = !made; made = true;
      if (!sock) return directStep(dir, { ...s, mkdir: s.mkdir || first }, signal);
      const limit = s.timeoutMs ?? 30 * 60_000;
      let t: ReturnType<typeof setTimeout> | undefined;
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      if (s.timeoutMs) t = setTimeout(() => { s.log(`\n[cobra] ${path.basename(s.cmd)} timed out after ${s.timeoutMs! / 1000}s; stopping\n`); ac.abort(); }, s.timeoutMs);
      try {
        return await launch(sock, { tenantId: opts.tenantId!, runId, engine: s.engine, args: s.args, env: launchEnv(s.env), workspace: dir,
          timeoutSec: Math.ceil(limit / 1000) + 5, mkdir: s.mkdir || first, files: s.files, readBack: s.readBack, rmAfter: s.rmAfter }, { signal: ac.signal, log: s.log });
      } finally { clearTimeout(t); signal.removeEventListener("abort", onAbort); }
    };
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
      const r = cwd === dir ? await step({ engine: "git", cmd: git, args, env: gitEnv, log: () => {} }) : await run(git, args, { cwd, env: gitEnv, signal, log: () => {} });
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.trim().slice(-400)}`);
      return r.out;
    };
    const branch = reuse?.branch ?? `cobra/${wsKey}`;
    let cloned = reuse?.cloned ?? false;
    note(`workspace ${dir}`);
    if (repo && token) { const denied = opts.checkRepo(repo); if (denied) throw new Error(denied); }
    if (reuse) note(`reusing this run's workspace (branch ${branch}); no clone`);
    else {
      if (repo && !token) note(`no GitHub token (repo PAT or GITHUB_TOKEN) is set, so ${repo} is not cloned; running in an empty scratch repo`);
      else if (repo) {
        const def = opts.defaultBranch?.(repo) ?? undefined;
        note(`cloning ${repo}${def ? ` (${def})` : ""}`);
        await g(["clone", "--depth", "1", ...(def ? ["--branch", def] : []), `${opts.remoteBase ?? "https://github.com"}/${repo}.git`, "."]);
        cloned = true;
      } else note("no repo selected; running in an empty scratch repo");
      if (!cloned) await g(["init", "-q"]);
      await g(["checkout", "-q", "-b", branch]);
      prepared.set(dir, { cloned, branch, sop: false });
    }
    // SOP skills: the full SOP body as a workspace file, kept out of commits via .git/info/exclude.
    // Written by the engine step (as the team user when launched), before the CLI starts.
    const pre: LaunchFile[] = [];
    if (typeof w.sop_body === "string" && w.sop_body) {
      const st = prepared.get(dir)!;
      pre.push({ path: ".cobra/SOP.md", content: w.sop_body, mode: "600" });
      if (!st.sop) { pre.push({ path: ".git/info/exclude", content: "\n.cobra/\n", append: true }); st.sop = true; }
      note("wrote the SOP to .cobra/SOP.md (excluded from git)");
    }

    const prompt = String(w.prompt ?? "").trim();
    if (!prompt) throw new Error("the run has no prompt");
    // The agent gets exactly one GitHub token, the same one used for the clone: the repo's PAT when set,
    // else GITHUB_TOKEN; none without a cloned repo. git inside the workspace authenticates via gitEnv.
    const env: Env = cloned && token ? { ...gitEnv, GH_TOKEN: token, GITHUB_TOKEN: token } : { ...base };
    const ghNote = cloned && token ? `\n\n[Cobra] GitHub access for ${repo} is in $GH_TOKEN (also $GITHUB_TOKEN). If the gh CLI is not installed, call the GitHub REST API (https://api.github.com) with curl and "Authorization: Bearer $GH_TOKEN". Never print the token.` : "";
    const LAST = ".git/cobra-last-message.txt", lastFile = path.join(dir, LAST);
    const pd = opts.providerDefaults?.(driver) ?? { model: null, effort: null };
    const own = typeof w.model === "string" && w.model.trim() ? w.model.trim() : null;
    const model = own ?? pd.model;
    const effort = pd.effort;
    let cmd: string, args: string[];
    let codexHome: { rel: string; file: string; login: string } | null = null;
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
        if (ra.codexLogin) {
          // The CLI only accepts a ChatGPT login as CODEX_HOME/auth.json. It lives under .git (never committed)
          // for this run only, mode 600, and is removed in the finally below.
          const rel = ".git/cobra-codex-home", file = `${rel}/auth.json`;
          pre.push({ path: file, content: buildAuthJson(ra.codexLogin), mode: "600" });
          codexHome = { rel, file, login: ra.codexLogin };
          env.CODEX_HOME = path.join(dir, rel);
        }
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
    const r = await step({ engine: driver, cmd, args, env, log: (s) => uc.write(s), timeoutMs: limit, files: pre,
      readBack: [LAST, ...(codexHome ? [codexHome.file] : [])], rmAfter: codexHome ? [codexHome.rel] : [] });
    if (codexHome) {
      try {
        const fresh = refreshedLogin(codexHome.login, r.files[codexHome.file] ?? null);
        if (fresh) { opts.onCodexLoginRefresh?.(fresh); note("codex refreshed the ChatGPT login; saved the new one (encrypted)"); }
      } catch (e) { note(`the refreshed ChatGPT login wasn't saved: ${(e as Error).message}`); }
    }
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
    const last = r.files[LAST];
    const summary = typeof last === "string" ? last.trim() : (parsed.text || r.out).trim().slice(-2000);
    return { driver, workspace: dir, branch, pushed, files: files.join(","), summary };
  };
}
