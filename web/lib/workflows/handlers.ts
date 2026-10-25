// Built-in step handlers. Pure Node (no Next imports) so the CLI and tests can use them.
import { spawn } from "node:child_process";
import type { Handlers, StepHandler } from "./engine";

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
});

/** Waits with.duration_ms and returns its `with` as the result (used by the simulated test run). */
export const simulate: StepHandler = async ({ with: w, signal }) => {
  await sleep(Number(w.duration_ms ?? 0), signal);
  return { ...w };
};

export const noop: StepHandler = async ({ with: w }) => ({ ...w });

/**
 * Runs a bash command on the Cobra server. Disabled unless COBRA_WORKFLOW_ALLOW_SHELL=1
 * because it is not sandboxed. Secrets listed on the step are passed as env vars only.
 */
export const shell: StepHandler = ({ run, secrets, signal, with: w }) => new Promise((resolve, reject) => {
  if (process.env.COBRA_WORKFLOW_ALLOW_SHELL !== "1") return reject(new Error("shell steps are disabled on this server (set COBRA_WORKFLOW_ALLOW_SHELL=1)"));
  const child = spawn("bash", ["-c", run ?? ""], {
    cwd: typeof w.cwd === "string" ? w.cwd : undefined,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...secrets } as unknown as NodeJS.ProcessEnv,
    signal,
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve({ stdout: stdout.trim(), exit_code: 0 });
    else reject(new Error(`exit code ${code}: ${(stderr || stdout).slice(-500)}`));
  });
});

/**
 * Runs a coding agent (src/agents drivers) in a worker workspace. The web app has
 * no workspace provider yet, so this needs an injected runner; without one it fails clearly.
 */
export type AgentRunner = (args: { runId: string; driver: "claude-code" | "codex"; with: Record<string, unknown>; secrets: Record<string, string>; signal: AbortSignal; timeoutMs?: number; log: (chunk: string) => void }) => Promise<Record<string, unknown>>;
export const agent = (runner?: AgentRunner): StepHandler => async ({ runId, stepKey, with: w, secrets, signal, timeoutMs, log }) => {
  const driver = (w.driver || "claude-code") as "claude-code" | "codex";
  if (driver !== "claude-code" && driver !== "codex") throw new Error(`unknown agent driver ${String(driver)}`);
  // Simulated mode: record what would run, execute nothing.
  if (w.mode === "simulated") return { simulated: true, driver, summary: `Simulated ${driver} run${w.repo ? ` on ${String(w.repo)}` : ""}; prompt: ${String(w.prompt ?? "")}` };
  if (!runner) throw new Error("no agent workspace provider is configured on this server; agent steps can't run yet");
  return runner({ runId: stepKey ?? runId, driver, with: w, secrets, signal, timeoutMs, log: log ?? (() => {}) });
};

/** GitHub REST actions with the GITHUB_TOKEN listed in the step's secrets (read from the env file at run time). */
/** Returns an error message when the acting team may not use the repo (team list + optional global ceiling). */
export type RepoCheck = (repo: string) => string | null;
const envCeiling: RepoCheck = (repo) => {
  const allowed = process.env.COBRA_GITHUB_ALLOWED_REPOS?.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
  return allowed?.length && !allowed.includes(repo.toLowerCase()) ? `repo ${repo} is not in COBRA_GITHUB_ALLOWED_REPOS` : null;
};
/** What the github issue/PR/merge actions know about the person who started the run (Job 21). */
export type CollabHooks = {
  /** True when the run's starter is the team's designated lead or a system admin. */
  canMerge: () => boolean;
  who: string;
  audit: (action: "issue_create" | "pr_create" | "merge", repo: string, number: number, runId: string, detail: string) => void;
};
export type GithubOptions = { agentRunner?: AgentRunner; collab?: CollabHooks };

/** tokenFor: THE per-repo resolver (repo PAT, else GITHUB_TOKEN); without one (CLI/tests) the step's GITHUB_TOKEN. */
export const github = (fetchImpl: typeof fetch = fetch, checkRepo: RepoCheck = envCeiling, tokenFor?: (repo: string) => string | undefined, gopts: GithubOptions = {}): StepHandler => async ({ runId, stepKey, with: w, secrets, signal, timeoutMs, log }) => {
  const repo = String(w.repo ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("with.repo must look like owner/name");
  const denied = checkRepo(repo);
  if (denied) throw new Error(denied);
  const simulated = w.mode === "simulated";
  const resolveToken = () => {
    const t = tokenFor ? tokenFor(repo) : secrets.GITHUB_TOKEN;
    if (!t) throw new Error(`no GitHub token for ${repo} (no repo PAT and no GITHUB_TOKEN)`);
    return t;
  };
  const call = async (method: string, url: string, body?: unknown) => {
    const token = resolveToken();
    const r = await fetchImpl(`https://api.github.com/repos/${repo}${url}`, {
      method, signal, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "cobra" },
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`GitHub ${method} ${url.split("?")[0]}: ${r.status} ${String(data.message ?? "")}`);
    return data;
  };
  const say = (m: string) => log?.(`[cobra] ${m}\n`);
  const footer = (extra = "") => gopts.collab ? `\n\n---\n_Created with Cobra by ${gopts.collab.who}${extra}_` : "";
  const posInt = (v: unknown, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error(`with.${name} must be a positive number`); return n; };
  switch (w.action) {
    case "create-issue": {
      const d = await call("POST", "/issues", { title: w.title, body: w.body ?? "" });
      return { number: d.number, url: d.html_url };
    }
    case "create-pr": {
      const d = await call("POST", "/pulls", { title: w.title, head: w.head, base: w.base ?? "main", body: w.body ?? "" });
      return { number: d.number, url: d.html_url };
    }
    case "merge-pr": {
      const d = await call("PUT", `/pulls/${Number(w.pr)}/merge`, { merge_method: w.merge_method ?? "squash", commit_title: w.commit_title });
      return { sha: d.sha, merged: d.merged };
    }
    // ---- Job 21: issue -> PR -> merge, each with a simulated mode (no GitHub, no agent).
    case "issue_create": {
      const title = String(w.title ?? "").trim();
      if (!title) throw new Error("with.title is required");
      if (simulated) { say(`simulated: would create issue "${title}" on ${repo}`); return { number: 0, url: "", simulated: true }; }
      const d = await call("POST", "/issues", { title: title.slice(0, 256), body: String(w.body ?? "") + footer(`, run ${runId}`) });
      gopts.collab?.audit("issue_create", repo, Number(d.number), runId, title);
      say(`created issue #${String(d.number)}`);
      return { number: d.number, url: d.html_url };
    }
    case "pr_from_issue": {
      const driver = (w.driver || "claude-code") as "claude-code" | "codex";
      if (driver !== "claude-code" && driver !== "codex") throw new Error(`unknown agent driver ${String(driver)}`);
      if (simulated) { say(`simulated: would run ${driver} on issue #${String(w.issue)} and open a PR`); return { number: 0, url: "", branch: "", head_sha: "", simulated: true, driver }; }
      const n = posInt(w.issue, "issue");
      if (!gopts.agentRunner) throw new Error("no agent workspace provider is configured on this server; agent steps can't run yet");
      const issue = await call("GET", `/issues/${n}`);
      const extra = String(w.instructions ?? "").trim();
      const prompt = `Resolve GitHub issue #${n} in ${repo}.\n\nTitle: ${String(issue.title ?? "")}\n\n${String(issue.body ?? "")}`.trim() + (extra ? `\n\nAdditional instructions:\n${extra}` : "") + "\n\nMake the code change in this repository and finish with a short summary of what you changed. Do not open the pull request yourself; Cobra opens it.";
      const res = await gopts.agentRunner({ runId: stepKey ?? runId, driver, with: { repo, prompt }, secrets, signal, timeoutMs, log: log ?? (() => {}) });
      const branch = String(res.branch ?? "");
      if (String(res.pushed) !== "true" || !branch) throw new Error(`the agent pushed no branch, so no PR was opened for #${n}`);
      const base = String(w.base ?? "").trim() || String((await call("GET", "")).default_branch ?? "main");
      const summary = String(res.summary ?? "").trim().slice(0, 4000);
      const pr = await call("POST", "/pulls", { title: `${String(issue.title ?? "")} (#${n})`.slice(0, 250), head: branch, base, body: `Closes #${n}\n\n${summary}${footer(` via ${driver}, run ${runId}`)}` });
      gopts.collab?.audit("pr_create", repo, Number(pr.number), runId, `for #${n}`);
      gopts.collab?.audit("pr_create", repo, n, runId, `PR #${String(pr.number)}`);
      say(`opened PR #${String(pr.number)} from ${branch} into ${base}`);
      return { number: pr.number, url: pr.html_url, branch, head_sha: String((pr.head as { sha?: string } | undefined)?.sha ?? ""), summary };
    }
    case "merge": {
      // The merge rule is enforced here, simulated or not: never bypassed by a workflow.
      if (!gopts.collab?.canMerge()) throw new Error(`merge not allowed: ${gopts.collab?.who ?? "the run's starter"} is not the team's designated lead or a system admin; PR${w.pr ? ` #${String(w.pr)}` : ""} is left open`);
      if (simulated) { say(`simulated: would merge PR #${String(w.pr)}`); return { merged: false, sha: "", simulated: true }; }
      const n = posInt(w.pr, "pr");
      const pr = await call("GET", `/pulls/${n}`);
      if (pr.merged || pr.state !== "open") throw new Error(`PR #${n} is not open`);
      const head = String((pr.head as { sha?: string } | undefined)?.sha ?? "");
      const pinned = String(w.sha ?? "").trim();
      if (pinned && pinned !== head) throw new Error(`PR #${n} head moved (${head.slice(0, 7)} != ${pinned.slice(0, 7)}); not merged`);
      const m = await call("PUT", `/pulls/${n}/merge`, { merge_method: "merge", sha: pinned || head });
      gopts.collab?.audit("merge", repo, n, runId, String(m.sha ?? "").slice(0, 12));
      say(`merged PR #${n} (${String(m.sha ?? "").slice(0, 7)})`);
      return { merged: m.merged, sha: m.sha };
    }
    default:
      throw new Error(`unknown github action ${String(w.action)}`);
  }
};

/**
 * Human approval gate inside a run. Needs a provider that waits for (or checks) a
 * decision by a user allowed by the workflow's governance/with.role; none is wired yet.
 */
export type ApprovalProvider = (args: { runId: string; stepId: string; role?: string; message?: string; signal: AbortSignal }) => Promise<{ approved: boolean; by: string; comment?: string }>;
export const approval = (provider?: ApprovalProvider): StepHandler => async ({ runId, step, with: w, signal }) => {
  if (!provider) throw new Error(`human approval gate '${step.id}' needs an approval provider; in-run approvals aren't wired up yet`);
  const d = await provider({ runId, stepId: step.id, role: w.role as string | undefined, message: w.message as string | undefined, signal });
  if (!d.approved) throw new Error(`rejected by ${d.by}${d.comment ? `: ${d.comment}` : ""}`);
  return { approved: true, by: d.by, comment: d.comment ?? "" };
};

export const builtinHandlers = (opts: { agentRunner?: AgentRunner; approvalProvider?: ApprovalProvider; fetch?: typeof fetch; checkRepo?: RepoCheck; tokenFor?: (repo: string) => string | undefined; collab?: CollabHooks } = {}): Handlers =>
  ({ simulate, noop, shell, agent: agent(opts.agentRunner), github: github(opts.fetch, opts.checkRepo, opts.tokenFor, { agentRunner: opts.agentRunner, collab: opts.collab }), approval: approval(opts.approvalProvider) });
