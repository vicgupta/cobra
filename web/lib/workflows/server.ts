// Next-side wiring: the acting user, secrets from the env file, handlers.
import "server-only";
import { readFileSync } from "node:fs";
import { getDb } from "../db";
import { envFilePath, parseEnv } from "../env-file";
import type { SessionUser } from "../auth/sessions";
import { builtinHandlers, type CollabHooks } from "./handlers";
import { audit, canMerge } from "../collab";
import type { Actor } from "./store";
import { localRunner } from "./local-runner";
import { checkTeamRepo, teamPatSecrets, teamRepo, tokenFor } from "../repos";
import { githubFiles } from "./github-files";
import { githubApi } from "../github-api";
import type { RunDeps } from "./service";
import { getProviderDefaults, getProviderSecret, providerSecretValues } from "../providers";
import { recordUsage } from "../usage";
import { getOpenRouterKey, OPENROUTER } from "../openrouter";

/** The one global OpenRouter key (any team): stored in Settings > Providers, else COBRA_OPENROUTER_API_KEY. */
export const openRouterKey = () => getOpenRouterKey(getDb(), secret("COBRA_SECRET_KEY"), secret(OPENROUTER.envFallback));

export const actor = (u: SessionUser): Actor => ({ id: u.id, email: u.email, role: u.role, tenantId: u.tenantId, name: u.name });

function envFile(): Record<string, string> {
  try { return parseEnv(readFileSync(envFilePath(), "utf8")); } catch { return {}; }
}

/** Secrets are read fresh from the server env file at run time (process.env as fallback); never stored in YAML. */
const secret = (name: string) => envFile()[name] || process.env[name] || undefined;
export const secretValue = secret;
/** Handlers scoped to a team: GitHub steps and agent clones only reach that team's registered repos. */
/** user: who starts the run; the github issue/PR/merge actions audit as them and enforce the merge rule (Job 21). */
export const runDeps = (tenantId: number, user?: Actor): RunDeps => {
  const db = getDb();
  const checkRepo = (repo: string) => checkTeamRepo(db, tenantId, repo);
  // One resolver for every GitHub touch (Job 20): the repo's PAT, else GITHUB_TOKEN.
  const token = githubTokenFor(tenantId);
  return {
    handlers: builtinHandlers({ checkRepo, tokenFor: token, collab: user ? collabHooks(db, user) : undefined, agentRunner: localRunner({ resolveSecret: secret, checkRepo, githubToken: token, defaultBranch: (r) => teamRepo(db, tenantId, r)?.defaultBranch, providerDefaults: (d) => getProviderDefaults(db, d), onUsage: (key, u) => recordUsage(db, key, u), providerSecret: (e) => getProviderSecret(db, e, secret("COBRA_SECRET_KEY")), openRouterKey }) }),
    resolveSecret: secret,
    // Every env-file value, every team PAT (plus its git header form) and provider secrets (CURSOR_API_KEY) are redacted from run logs and errors.
    redact: () => [...Object.values(envFile()), ...teamPatSecrets(db, tenantId, secret("COBRA_SECRET_KEY")), ...providerSecretValues(db, secret("COBRA_SECRET_KEY")), ...[openRouterKey()].filter((v): v is string => !!v)],
  };
};

const collabHooks = (db: ReturnType<typeof getDb>, u: Actor): CollabHooks => ({
  canMerge: () => canMerge(db, u),
  who: u.email,
  audit: (action, repo, number, runId, detail) => audit(db, u, action, repo, number, runId, detail),
});

/** True when GITHUB_TOKEN is set (value never returned). */
export const githubTokenSet = () => !!secret("GITHUB_TOKEN");

export { getDb };

/** COBRA_SECRET_KEY (encrypts per-repo PATs); never returned. */
export const secretKey = () => secret("COBRA_SECRET_KEY");

/** THE per-repo GitHub token resolver (Job 20), used by every path: the team's PAT for the repo when set,
 *  else GITHUB_TOKEN. Both read at call time, never returned to clients. */
export const githubTokenFor = (tenantId: number) => (repo: string) => tokenFor(getDb(), tenantId, secretKey(), secret("GITHUB_TOKEN"))(repo);
const teamToken = githubTokenFor;

/** GitHub contents client for storage: github (repo PAT, else GITHUB_TOKEN). */
export const githubStore = (tenantId: number) => githubFiles(teamToken(tenantId));

/** GitHub issues/PR client (repo PAT, else GITHUB_TOKEN). */
export const githubClient = (tenantId: number) => githubApi(teamToken(tenantId));
