// Reads the server environment file that the web Settings page writes
// (default /etc/cobra/cobra.env, override with COBRA_ENV_FILE). Format, shared
// with web/lib/env-file.ts and compatible with systemd EnvironmentFile:
//   KEY="value"   value double-quoted; \\ \" and newlines (\n) escaped.
// Blank lines and lines starting with # are ignored. Unquoted values are taken as-is.
import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_ENV_FILE = "/etc/cobra/cobra.env";

export function envFilePath(): string {
  return process.env.COBRA_ENV_FILE || DEFAULT_ENV_FILE;
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

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = unescapeValue(m[2]);
  }
  return out;
}

/** The env file's values read fresh, or undefined when the file doesn't exist or can't be read. */
export function readEnvFile(path: string = envFilePath()): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
