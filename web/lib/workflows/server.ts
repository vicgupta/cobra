// Next-side wiring: the acting user, secrets from the env file, handlers.
import "server-only";
import { readFileSync } from "node:fs";
import { getDb } from "../db";
import { envFilePath, parseEnv } from "../env-file";
import type { SessionUser } from "../auth/sessions";
import { builtinHandlers } from "./handlers";
import { localRunner } from "./local-runner";
import { checkTeamRepo, teamPatSecrets, teamRepo, tokenFor } from "../repos";
import { githubFiles } from "./github-files";
import { githubApi } from "../github-api";
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
  // A repo's own PAT (Job 19) wins over GITHUB_TOKEN; undefined means "use the step's GITHUB_TOKEN".
  const repoToken = (repo: string) => repoTokenFor(tenantId)(repo) || undefined;
  return {
    handlers: builtinHandlers({ checkRepo, tokenFor: repoToken, agentRunner: localRunner({ resolveSecret: secret, checkRepo, repoToken, defaultBranch: (r) => teamRepo(db, tenantId, r)?.defaultBranch }) }),
    resolveSecret: secret,
    // Every env-file value and every team PAT (plus its git header form) is redacted from run logs and errors.
    redact: () => [...Object.values(envFile()), ...teamPatSecrets(db, tenantId, secret("COBRA_SECRET_KEY"))],
  };
};

/** True when GITHUB_TOKEN is set (value never returned). */
export const githubTokenSet = () => !!secret("GITHUB_TOKEN");

export { getDb };

/** COBRA_SECRET_KEY (encrypts per-repo PATs); never returned. */
export const secretKey = () => secret("COBRA_SECRET_KEY");

/** Per repo: the team's PAT for it when set, else GITHUB_TOKEN (both read at call time, never returned). */
const repoTokenFor = (tenantId: number) => (repo: string) => tokenFor(getDb(), tenantId, secretKey(), undefined)(repo);
const teamToken = (tenantId: number) => (repo: string) => repoTokenFor(tenantId)(repo) || secret("GITHUB_TOKEN");

/** GitHub contents client for storage: github (repo PAT, else GITHUB_TOKEN). */
export const githubStore = (tenantId: number) => githubFiles(teamToken(tenantId));

/** GitHub issues/PR client (repo PAT, else GITHUB_TOKEN). */
export const githubClient = (tenantId: number) => githubApi(teamToken(tenantId));
