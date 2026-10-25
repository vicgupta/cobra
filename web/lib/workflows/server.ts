// Next-side wiring: the acting user, secrets from the env file, handlers.
import "server-only";
import { readFileSync } from "node:fs";
import { getDb } from "../db";
import { envFilePath, parseEnv } from "../env-file";
import type { SessionUser } from "../auth/sessions";
import { builtinHandlers } from "./handlers";
import { localRunner } from "./local-runner";
import { checkTeamRepo, teamRepo } from "../repos";
import { githubFiles } from "./github-files";
import type { RunDeps } from "./service";
import type { Actor } from "./store";

export const actor = (u: SessionUser): Actor => ({ id: u.id, email: u.email, role: u.role, tenantId: u.tenantId, name: u.name });

function envFile(): Record<string, string> {
  try { return parseEnv(readFileSync(envFilePath(), "utf8")); } catch { return {}; }
}

/** Secrets are read fresh from the server env file at run time (process.env as fallback); never stored in YAML. */
const secret = (name: string) => envFile()[name] || process.env[name] || undefined;
/** Handlers scoped to a team: GitHub steps and agent clones only reach that team's registered repos. */
export const runDeps = (tenantId: number): RunDeps => {
  const db = getDb();
  const checkRepo = (repo: string) => checkTeamRepo(db, tenantId, repo);
  return {
    handlers: builtinHandlers({ checkRepo, agentRunner: localRunner({ resolveSecret: secret, checkRepo, defaultBranch: (r) => teamRepo(db, tenantId, r)?.defaultBranch }) }),
    resolveSecret: secret,
    redact: () => Object.values(envFile()),
  };
};

/** True when GITHUB_TOKEN is set (value never returned). */
export const githubTokenSet = () => !!secret("GITHUB_TOKEN");

export { getDb };

/** GitHub contents client for storage: github, using GITHUB_TOKEN from the env file at call time. */
export const githubStore = () => githubFiles(envFile().GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined);
