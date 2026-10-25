// Drives Claude Code inside a worker workspace: signs it in, copies job files
// such as a house CLAUDE.md, runs it headless on a task, and reads back its
// final reply, which becomes the pull request description.
//
// Ported from vicgupta/create-ant-factory (assets/template/src/agents.mjs and
// the "claude" agent entry in factory.config.json).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { readEnvFile } from "../config/env-file.js";
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
  /** Shown in error messages. */
  name?: string;
  /** Subscription sign-in. Used first whenever its secret is available. */
  auth: SecretEntry[];
  /** API-key sign-in. Used only when no subscription token is available. */
  apiKeyAuth?: SecretEntry[];
  env?: Record<string, string>;
  jobFiles?: JobFile[];
  /** {prompt} is the task file and {summary} is where the final reply goes. */
  command: string;
}

/**
 * Claude Code. Signs in with a subscription token from `claude setup-token`
 * (CLAUDE_CODE_OAUTH_TOKEN) when one is available, otherwise with an
 * Anthropic API key (ANTHROPIC_API_KEY).
 */
export const CLAUDE_CODE: ClaudeCodeConfig = {
  name: "Claude Code",
  auth: [{ secret: "CLAUDE_CODE_OAUTH_TOKEN", env: "CLAUDE_CODE_OAUTH_TOKEN" }],
  apiKeyAuth: [{ secret: "ANTHROPIC_API_KEY", env: "ANTHROPIC_API_KEY" }],
  command: 'claude -p "$(cat {prompt})" --dangerously-skip-permissions --output-format text > {summary}',
};

export type AuthMode = "subscription" | "api-key";

/**
 * Credentials passed in by the caller. When given, these are used instead of
 * the environment. The subscription token wins if both are set.
 */
export interface Credentials {
  subscriptionToken?: string;
  apiKey?: string;
}

export interface ResolvedAuth {
  mode: AuthMode;
  /** Each sign-in entry with its value. Never log this. */
  entries: Array<{ entry: SecretEntry; value: string }>;
}

/** Reads a secret's value without ever printing it. */
export function readSecret(entry: SecretEntry): string | undefined {
  // The server env file (COBRA_ENV_FILE) is authoritative when it exists, read
  // fresh each call so Settings changes apply on the next run without a restart.
  const file = readEnvFile();
  if (file) {
    const fromFile = file[entry.secret];
    if (fromFile) return fromFile;
    if (process.env[entry.secret]) {
      // Present in the env only because systemd loaded an older copy of the file;
      // the file no longer sets it, so treat it as cleared.
      if (fileTracksKey(entry.secret)) return undefined;
    }
  }
  const fromEnv = process.env[entry.secret];
  if (fromEnv) return fromEnv;
  try {
    const blob = JSON.parse(process.env.FACTORY_SECRETS_JSON ?? "{}") as Record<string, string | undefined>;
    const fromBlob = blob[entry.secret];
    if (fromBlob) return fromBlob;
  } catch {
    // Malformed blob: fall through to the local file.
  }
  const local = entry.localFile?.replace(/^~/, homedir());
  return local && existsSync(local) ? readFileSync(local, "utf8") : undefined;
}

/** GitHub token from Settings (GITHUB_TOKEN), read fresh from the env file on each call. Never log it. */
export function readGithubToken(): string | undefined {
  return readSecret({ secret: "GITHUB_TOKEN" });
}

/** Keys managed by the Settings page; a missing value in the env file means cleared. */
export const MANAGED_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_AUTH_JSON", "CODEX_API_KEY", "GITHUB_TOKEN"];
const fileTracksKey = (key: string) => MANAGED_KEYS.includes(key);

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

/** Every path the driver writes secrets to, so they can be removed after a job. */
export function secretPaths(agent: ClaudeCodeConfig = CLAUDE_CODE): string[] {
  return [`${HOME}/.factory`, ...[...agent.auth, ...(agent.apiKeyAuth ?? [])].flatMap((a) => (a.file ? [a.file] : []))];
}

const fromEntries = (entries: SecretEntry[] | undefined, read: (e: SecretEntry) => string | undefined) => {
  if (!entries?.length) return undefined;
  const pairs = entries.map((entry) => ({ entry, value: read(entry) }));
  return pairs.every((p) => p.value) ? (pairs as ResolvedAuth["entries"]) : undefined;
};

/**
 * Picks how the agent signs in. With caller credentials, uses the
 * subscription token if given, otherwise the API key. Without them, reads the
 * environment the same way: subscription secrets first, then the API key.
 */
export function resolveAuth(agent: ClaudeCodeConfig, credentials?: Credentials): ResolvedAuth {
  const label = agent.name ?? "the agent";
  if (credentials && (credentials.subscriptionToken || credentials.apiKey)) {
    if (credentials.subscriptionToken) {
      const entries = fromEntries(agent.auth, () => credentials.subscriptionToken);
      if (entries) return { mode: "subscription", entries };
    }
    const entries = fromEntries(agent.apiKeyAuth, () => credentials.apiKey);
    if (credentials.apiKey && entries) return { mode: "api-key", entries };
    throw new Error(`${label} has no sign-in that matches the credentials provided`);
  }
  const sub = fromEntries(agent.auth, readSecret);
  if (sub) return { mode: "subscription", entries: sub };
  const key = fromEntries(agent.apiKeyAuth, readSecret);
  if (key) return { mode: "api-key", entries: key };
  const names = [...agent.auth, ...(agent.apiKeyAuth ?? [])].map((e) => e.secret).join(" or ");
  throw new Error(`${label} needs a sign-in: set ${names}`);
}

/**
 * Places the agent's sign-in in the workspace, readable only by the agent.
 * Returns which mode was used: subscription or API key.
 */
export async function signIn(ws: Workspace, agent: ClaudeCodeConfig = CLAUDE_CODE, credentials?: Credentials): Promise<AuthMode> {
  const { mode, entries } = resolveAuth(agent, credentials);
  const lines = Object.entries(agent.env ?? {}).map(([key, value]) => `export ${key}=${q(value)}`);
  await sh(ws, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`);
  for (const { entry, value } of entries) {
    if (entry.env) lines.push(`export ${entry.env}=${q(value)}`);
    if (entry.file) {
      await sh(ws, `mkdir -p ${q(dirOf(entry.file))} && chmod 700 ${q(dirOf(entry.file))}`);
      await ws.files.write({ path: entry.file, content: value });
      await sh(ws, `chmod 600 ${q(entry.file)}`);
    }
  }
  await ws.files.write({ path: ENV_FILE, content: lines.join("\n") + "\n" });
  await sh(ws, `chmod 600 ${ENV_FILE}`);
  return mode;
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
