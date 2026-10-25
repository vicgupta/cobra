// Drives the OpenAI Codex CLI inside a worker workspace, the same way the
// Claude Code driver does: signs it in, copies job files such as a house
// AGENTS.md, runs `codex exec` headless on a task, and reads back its final
// reply, which becomes the pull request description.
//
// Ported from vicgupta/create-ant-factory (assets/template/src/agents.mjs, the
// "codex" agent entry in factory.config.json, and references/agents.md).
import { HOME, signIn, writeJobFiles, buildCommand, ENV_FILE, type ClaudeCodeConfig, type RunOptions, type RunResult } from "./claude-code.js";
import { q, sh, runScript, type Workspace } from "./workspace.js";

/** Same shape as the Claude Code config: auth, env, job files and a command. */
export type CodexConfig = ClaudeCodeConfig;

/** Codex reads its config.toml and auth.json from here. */
export const CODEX_HOME = `${HOME}/.codex`;

const CODEX_COMMAND =
  'codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --output-last-message {summary} "$(cat {prompt})"';

/**
 * Codex signed in with a ChatGPT plan. The secret is the content of
 * ~/.codex/auth.json after `codex login`. Codex rotates its refresh token, so a
 * copy shared with your own machine can stop working; for a long-lived
 * factory prefer CODEX_WITH_API_KEY or a sign-in made just for Cobra.
 */
export const CODEX: CodexConfig = {
  name: "Codex",
  auth: [{ secret: "CODEX_AUTH_JSON", file: `${CODEX_HOME}/auth.json`, localFile: "~/.codex/auth.json" }],
  env: { CODEX_HOME },
  command: CODEX_COMMAND,
};

/** Codex signed in with an API key (CODEX_API_KEY for `codex exec`). */
export const CODEX_WITH_API_KEY: CodexConfig = {
  name: "Codex",
  auth: [{ secret: "CODEX_API_KEY", env: "CODEX_API_KEY" }],
  env: { CODEX_HOME },
  command: CODEX_COMMAND,
};

/** Places Codex's sign-in in the workspace, readable only by the agent. */
export const signInCodex = (ws: Workspace, agent: CodexConfig = CODEX): Promise<void> => signIn(ws, agent);

/** Copies job files (such as `~/.codex/AGENTS.md`) into the workspace, fresh each job. */
export const writeCodexJobFiles = (ws: Workspace, agent: CodexConfig, baseDir: string): Promise<void> =>
  writeJobFiles(ws, agent, baseDir);

/**
 * Runs Codex on a task in the background and polls it. The task goes in
 * through a file, and `--output-last-message` writes the final reply to the
 * summary file.
 */
export async function runCodex(ws: Workspace, opts: RunOptions, agent: CodexConfig = CODEX): Promise<RunResult> {
  const promptFile = `${opts.jobDir}/prompt.md`;
  const summaryFile = `${opts.jobDir}/summary.md`;
  await sh(ws, `mkdir -p ${q(opts.jobDir)} ${q(opts.workDir)} && rm -f ${summaryFile}`);
  await ws.files.write({ path: promptFile, content: opts.prompt });
  const result = await runScript(ws, {
    name: "agent",
    dir: opts.jobDir,
    timeoutMinutes: opts.timeoutMinutes,
    onTick: opts.onTick ?? ((m) => console.log(`  Codex still working (${m} min)`)),
    body: [`source ${ENV_FILE}`, "export PATH=$HOME/.local/bin:$PATH", `cd ${q(opts.workDir)}`, buildCommand(agent, promptFile, summaryFile)],
  });
  const summary = (await sh(ws, `cat ${summaryFile} 2>/dev/null`, { allowFailure: true })).output.trim();
  return { ...result, summary };
}
