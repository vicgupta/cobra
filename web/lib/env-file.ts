// Server environment file used by the agent drivers (see src/config/env-file.ts
// at the repo root, which parses the same format). Lines are KEY="value" with
// \\, \" and newlines (\n) escaped; compatible with systemd EnvironmentFile.
import "server-only";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { AGENT_ENV, resolveAuthMode } from "./settings";
import type { AgentId, AuthMode } from "./types";

export const MANAGED_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_AUTH_JSON", "CODEX_API_KEY", "GITHUB_TOKEN"] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

const DEFAULT_ENV_FILE = "/etc/cobra/cobra.env";
const DEV_ENV_FILE = path.join(process.cwd(), "data", "cobra.env");

/** COBRA_ENV_FILE, else /etc/cobra/cobra.env if present, else web/data/cobra.env (local dev, gitignored). */
export function envFilePath(): string {
  if (process.env.COBRA_ENV_FILE) return process.env.COBRA_ENV_FILE;
  return existsSync(DEFAULT_ENV_FILE) ? DEFAULT_ENV_FILE : DEV_ENV_FILE;
}

export function escapeValue(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"';
}

export function unescapeValue(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
  }
  return v;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const PLACEHOLDER = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)=/;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = unescapeValue(m[2]);
  }
  return out;
}

async function readText(): Promise<string> {
  try {
    return await fs.readFile(envFilePath(), "utf8");
  } catch {
    return "";
  }
}

export async function readManaged(): Promise<Record<ManagedKey, string>> {
  const all = parseEnv(await readText());
  return Object.fromEntries(MANAGED_KEYS.map((k) => [k, all[k] ?? ""])) as Record<ManagedKey, string>;
}

/**
 * Applies changes to managed keys only ("" clears to a `#KEY=` placeholder),
 * preserving every other line. Writes in place so the file's mode and owner stay.
 */
export async function writeManaged(changes: Partial<Record<ManagedKey, string>>): Promise<void> {
  const file = envFilePath();
  const exists = existsSync(file);
  const lines = (await readText()).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of Object.entries(changes) as [ManagedKey, string][]) {
    const next = value ? `${key}=${escapeValue(value)}` : `#${key}=`;
    const idx = lines.findIndex((l) => {
      const m = LINE.exec(l);
      return m && !l.trimStart().startsWith("#") ? m[1] === key : false;
    });
    const ph = idx >= 0 ? idx : lines.findIndex((l) => PLACEHOLDER.exec(l)?.[1] === key);
    if (ph >= 0) {
      lines[ph] = next;
      // Drop any duplicate active lines for the key.
      for (let i = lines.length - 1; i > ph; i--) {
        const m = LINE.exec(lines[i]);
        if (m && m[1] === key && !lines[i].trimStart().startsWith("#")) lines.splice(i, 1);
      }
    } else lines.push(next);
  }
  const text = lines.join("\n") + "\n";
  if (exists) {
    const fh = await fs.open(file, "r+");
    try {
      await fh.truncate(0);
      await fh.write(text, 0, "utf8");
    } finally {
      await fh.close();
    }
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, { mode: 0o600 });
  }
}

/** The sign-in mode each agent driver would use, from the env file. */
export async function agentModes(): Promise<Record<AgentId, AuthMode>> {
  const v = await readManaged();
  const out = {} as Record<AgentId, AuthMode>;
  for (const [a, e] of Object.entries(AGENT_ENV) as [AgentId, (typeof AGENT_ENV)[AgentId]][]) {
    out[a] = resolveAuthMode({ subscription: !!v[e.subscription as ManagedKey], apiKey: !!v[e.apiKey as ManagedKey] });
  }
  return out;
}
