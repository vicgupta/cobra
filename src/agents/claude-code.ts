// Drives Claude Code inside a worker workspace: signs it in, copies job files
// such as a house CLAUDE.md, runs it headless on a task, and reads back its
// final reply, which becomes the pull request description.
//
// Ported from vicgupta/create-ant-factory (assets/template/src/agents.mjs and
// the "claude" agent entry in factory.config.json).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { q, sh, runScript, type ScriptResult, type Workspace } from "./workspace.js";

export const HOME = "/workspace/home";
export const ENV_FILE = `${HOME}/.factory/env`;

export interface SecretEntry {
  /** Name of the secret in the environment or in FACTORY_SECRETS_JSON. */
  secret: string;
  /** Export the value as this variable. */
  env?: string;
  /** Or write the value to this path in the workspace. */
  file?: string;
  /** Local file to read the value from when it isn't in the environment. */
  localFile?: string;
}

export interface JobFile {
  /** Path on this machine, relative to baseDir. */
  from: string;
  /** Path in the workspace. */
  to: string;
}

export interface ClaudeCodeConfig {
  auth: SecretEntry[];
  env?: Record<string, string>;
  jobFiles?: JobFile[];
  /** {prompt} is the task file and {summary} is where the final reply goes. */
  command: string;
}

/** Claude Code signed in with a subscription token from `claude setup-token`. */
export const CLAUDE_CODE: ClaudeCodeConfig = {
  auth: [{ secret: "CLAUDE_CODE_OAUTH_TOKEN", env: "CLAUDE_CODE_OAUTH_TOKEN" }],
  command: 'claude -p "$(cat {prompt})" --dangerously-skip-permissions --output-format text > {summary}',
};

/** Same driver, signed in with an Anthropic API key instead. */
export const CLAUDE_CODE_API_KEY: ClaudeCodeConfig = {
  ...CLAUDE_CODE,
  auth: [{ secret: "ANTHROPIC_API_KEY", env: "ANTHROPIC_API_KEY" }],
};

/** Reads a secret's value without ever printing it. */
export function readSecret(entry: SecretEntry): string | undefined {
  const fromEnv = process.env[entry.secret];
  if (fromEnv) return fromEnv;
  try {
    const blob = JSON.parse(process.env.FACTORY_SECRETS_JSON ?? "{}") as Record<string, string | undefined>;
    const fromBlob = blob[entry.secret];
    if (fromBlob) return fromBlob;
  } catch {
    // Malformed blob: fall through to the local file.
  }
  const file = entry.localFile?.replace(/^~/, homedir());
  return file && existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

/** Every path the driver writes secrets to, so they can be removed after a job. */
export function secretPaths(agent: ClaudeCodeConfig = CLAUDE_CODE): string[] {
  return [`${HOME}/.factory`, ...agent.auth.flatMap((a) => (a.file ? [a.file] : []))];
}

/** Places Claude Code's sign-in in the workspace, readable only by the agent. */
export async function signIn(ws: Workspace, agent: ClaudeCodeConfig = CLAUDE_CODE): Promise<void> {
  const lines = Object.entries(agent.env ?? {}).map(([key, value]) => `export ${key}=${q(value)}`);
  await sh(ws, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`);
  for (const entry of agent.auth) {
    const value = readSecret(entry);
    if (!value) throw new Error(`Secret ${entry.secret} is not set, and Claude Code needs it`);
    if (entry.env) lines.push(`export ${entry.env}=${q(value)}`);
    if (entry.file) {
      await sh(ws, `mkdir -p ${q(dirOf(entry.file))} && chmod 700 ${q(dirOf(entry.file))}`);
      await ws.files.write({ path: entry.file, content: value });
      await sh(ws, `chmod 600 ${q(entry.file)}`);
    }
  }
  await ws.files.write({ path: ENV_FILE, content: lines.join("\n") + "\n" });
  await sh(ws, `chmod 600 ${ENV_FILE}`);
}

/** Copies job files (such as a house CLAUDE.md) into the workspace, fresh each job. */
export async function writeJobFiles(ws: Workspace, agent: ClaudeCodeConfig, baseDir: string): Promise<void> {
  for (const file of agent.jobFiles ?? []) {
    const content = readFileSync(new URL(file.from, new URL(`file://${baseDir.replace(/\/?$/, "/")}`)), "utf8").replaceAll("\r\n", "\n");
    await sh(ws, `mkdir -p ${q(dirOf(file.to))}`);
    await ws.files.write({ path: file.to, content });
  }
}

export interface RunOptions {
  workDir: string;
  jobDir: string;
  prompt: string;
  timeoutMinutes: number;
  onTick?: (minutes: string) => void;
}

export interface RunResult extends ScriptResult {
  /** Claude Code's final reply. Empty if it never reached the summary file. */
  summary: string;
}

/** Builds the shell command, filling in the prompt and summary file paths. */
export function buildCommand(agent: ClaudeCodeConfig, promptFile: string, summaryFile: string): string {
  return agent.command.replaceAll("{prompt}", promptFile).replaceAll("{summary}", summaryFile);
}

/**
 * Runs Claude Code on a task in the background and polls it. The task goes in
 * through a file, and the final reply comes back from the summary file.
 */
export async function runClaudeCode(ws: Workspace, opts: RunOptions, agent: ClaudeCodeConfig = CLAUDE_CODE): Promise<RunResult> {
  const promptFile = `${opts.jobDir}/prompt.md`;
  const summaryFile = `${opts.jobDir}/summary.md`;
  await sh(ws, `mkdir -p ${q(opts.jobDir)} ${q(opts.workDir)} && rm -f ${summaryFile}`);
  await ws.files.write({ path: promptFile, content: opts.prompt });
  const result = await runScript(ws, {
    name: "agent",
    dir: opts.jobDir,
    timeoutMinutes: opts.timeoutMinutes,
    onTick: opts.onTick ?? ((m) => console.log(`  Claude Code still working (${m} min)`)),
    body: [`source ${ENV_FILE}`, "export PATH=$HOME/.local/bin:$PATH", `cd ${q(opts.workDir)}`, buildCommand(agent, promptFile, summaryFile)],
  });
  const summary = (await sh(ws, `cat ${summaryFile} 2>/dev/null`, { allowFailure: true })).output.trim();
  return { ...result, summary };
}
