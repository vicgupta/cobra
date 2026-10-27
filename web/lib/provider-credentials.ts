// Settings > Providers: unified credential manager, per team (tenant-scoped, migration 28). Every member
// of a team (member, team lead, designated lead) manages that team's credentials and custom providers;
// system admins (role admin, no team role) see the read-only view. Runs only ever see their own team's rows.
// The server env file / CLI logins are a fallback for team 1 (Vic) only; other teams get a clear error.
//
// Each built-in provider has credential slots by auth type. Values are stored AES-256-GCM encrypted
// (lib/secret-box.ts, COBRA_SECRET_KEY) in team_provider_secrets (tenant_id, engine, name); views carry set / not set,
// the last 4 characters, who and when, never the value. Every set / replace / delete and auth-method
// change is written to provider_audit. A stored value wins over the server env file (the env fallback).
//
// Auth types, verified on nova 2026-10-26 (CLI help + vendor docs):
//   Claude Code 2.1.310: API key ANTHROPIC_API_KEY; subscription CLAUDE_CODE_OAUTH_TOKEN from
//     `claude setup-token` ("Set up a long-lived authentication token (requires Claude subscription)").
//   Codex 0.164.0: API key CODEX_API_KEY (exec; takes precedence over any login); subscription is the
//     server's ChatGPT login (~/.codex/auth.json, `codex login`) or a pasted ChatGPT login stored in the
//     CODEX_ACCESS_TOKEN slot (auth.json contents or a bare access token; see lib/codex-login.ts). It reaches
//     the CLI as auth.json in a per-run CODEX_HOME, never as the CODEX_ACCESS_TOKEN env var (0.164.0 reads
//     that variable as an agent-identity JWT, so a ChatGPT token there fails with "401 Missing bearer").
//   OpenCode 1.19.4: API key OPENCODE_API_KEY (OpenCode Zen). No subscription mode of its own (openai/*
//     models reuse the Codex ChatGPT login). Custom OpenAI-compatible providers: see custom providers below.
//   Cursor 2026.10.22: API key CURSOR_API_KEY. `cursor-agent login` is an interactive browser login that
//     Cobra can't drive, so there's no subscription mode; the key itself is issued under the Cursor plan.
//   OpenRouter (ON HOLD, existing code paths only): API key OPENROUTER_API_KEY.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { CollabError, isSystemAdmin } from "./collab";
import { decryptSecret, encryptSecret } from "./secret-box";
import type { AgentEngine } from "./agents";
import { CODEX_LOGIN_SLOT, codexLoginSecrets, codexLoginStatus, parseCodexLogin, type CodexLoginStatus } from "./codex-login";

export type AuthType = "api_key" | "subscription";
export type AuthMode = "auto" | AuthType;
export type CredentialSlot = { name: string; type: AuthType; label: string; help: string };
export type ProviderAuthSpec = { id: string; label: string; slots: CredentialSlot[]; modes: AuthMode[]; noSubscription?: string; serverLogin?: string };

export const PROVIDER_AUTH: Record<AgentEngine, ProviderAuthSpec> = {
  "claude-code": {
    id: "claude-code", label: "Claude Code", modes: ["auto", "api_key", "subscription"],
    slots: [
      { name: "ANTHROPIC_API_KEY", type: "api_key", label: "Anthropic API key", help: "From console.anthropic.com > API keys. Passed to claude as ANTHROPIC_API_KEY." },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", type: "subscription", label: "Claude subscription token", help: "Run `claude setup-token` on any machine signed in to a Claude Pro/Max plan and paste the long-lived token. Passed as CLAUDE_CODE_OAUTH_TOKEN." },
    ],
  },
  codex: {
    id: "codex", label: "Codex", modes: ["auto", "api_key", "subscription"],
    serverLogin: "ChatGPT login on the server (~/.codex/auth.json via `codex login`)",
    slots: [
      { name: "CODEX_API_KEY", type: "api_key", label: "OpenAI API key", help: "From platform.openai.com > API keys. Passed to codex exec as CODEX_API_KEY (overrides any login for that run)." },
      { name: "CODEX_ACCESS_TOKEN", type: "subscription", label: "ChatGPT login", help: "Run `codex login` on your computer and sign in with ChatGPT, then paste the contents of ~/.codex/auth.json here (on Windows: %USERPROFILE%\\.codex\\auth.json). Cobra stores it encrypted and keeps it refreshed. A bare ChatGPT access token also works, but only until it expires." },
    ],
  },
};

type Admin = { id: number; email: string; role: string; tenantId: number };

/** The team whose credentials may fall back to the server env file and the cobra user's CLI logins. */
export const ENV_FALLBACK_TEAM = 1;
/** Who manages a team's providers: anyone with a team role (member, team lead, designated lead). */
export const canManageProviders = (u: { role: string }) => !isSystemAdmin(u);
/** Env lookup for a team: the real env file for team 1, nothing for everyone else. */
export const teamEnv = (tenantId: number, env: (n: string) => string | undefined) => (n: string) => (tenantId === ENV_FALLBACK_TEAM ? env(n) : undefined);
export const noCredential = (what: string) => `no credential set for this team: ${what} (a team member adds it in Settings > Providers)`;
export type CredentialView = CredentialSlot & { set: boolean; source: "stored" | "env" | null; last4: string | null; setAt: number | null; setBy: string | null; codexLogin?: CodexLoginStatus | null };

const row = (db: DB, t: number, engine: string, name: string) =>
  db.prepare("SELECT value_enc, set_at, set_by FROM team_provider_secrets WHERE tenant_id = ? AND engine = ? AND name = ?").get(t, engine, name) as { value_enc: string; set_at: number; set_by: string | null } | undefined;
const tail = (v: string) => (v.length >= 12 ? v.slice(-4) : null);
const envName = (_engine: string, name: string) => name;
const isCodexLogin = (engine: string, name: string) => engine === "codex" && name === CODEX_LOGIN_SLOT;

/** Stored value (decrypted) for a run; undefined when unset/undecryptable. Never log the result. */
export function storedCredential(db: DB, t: number, engine: string, name: string, secretKey: string | undefined): string | undefined {
  const r = row(db, t, engine, name);
  if (!r) return undefined;
  try { return decryptSecret(r.value_enc, secretKey); } catch { console.error(`[cobra] the stored ${name} for ${engine} can't be decrypted (COBRA_SECRET_KEY changed?)`); return undefined; }
}

/** Stored value, else the env fallback (same name in the server env file). */
export function resolveCredential(db: DB, t: number, engine: string, name: string, secretKey: string | undefined, env: (n: string) => string | undefined): string | undefined {
  return storedCredential(db, t, engine, name, secretKey) ?? (teamEnv(t, env)(envName(engine, name))?.trim() || undefined);
}

export function credentialViews(db: DB, t: number, engine: keyof typeof PROVIDER_AUTH, secretKey: string | undefined, env: (n: string) => string | undefined, withDetail: boolean): CredentialView[] {
  return PROVIDER_AUTH[engine].slots.map((s) => {
    const r = row(db, t, engine, s.name);
    const login = isCodexLogin(engine, s.name);
    let last4: string | null = null, codexLogin: CodexLoginStatus | null | undefined;
    if (r && withDetail) { const v = storedCredential(db, t, engine, s.name, secretKey); if (login) codexLogin = codexLoginStatus(v); else last4 = v ? tail(v) : null; }
    const envSet = !r && !!teamEnv(t, env)(envName(engine, s.name))?.trim();
    return { ...s, set: !!r || envSet, source: r ? "stored" : envSet ? "env" : null, last4, setAt: withDetail ? r?.set_at ?? null : null, setBy: withDetail ? r?.set_by ?? null : null, ...(login ? { codexLogin: codexLogin ?? null } : {}) };
  });
}

const audit = (db: DB, u: Admin, engine: string, detail: string, now: number) =>
  db.prepare("INSERT INTO provider_audit (tenant_id, actor_id, actor_email, engine, at, detail) VALUES (?, ?, ?, ?, ?, ?)").run(u.tenantId, u.id, u.email, engine, now, detail);

function requireManager(u: Admin, what: string) { if (!canManageProviders(u)) throw new CollabError(403, `only members of the team can change its ${what} (system admins without a team role can't)`); }

export function checkSecretValue(v: unknown, label: string): string {
  if (typeof v !== "string") throw new CollabError(400, "value must be a string, or null to delete");
  const t = v.trim();
  if (t.length < 8 || t.length > 4000 || /\s/.test(t)) throw new CollabError(400, `${label} looks invalid (8-4000 characters, no spaces)`);
  return t;
}

function writeSecret(db: DB, t: number, engine: string, name: string, value: string, secretKey: string | undefined, by: string, now: number) {
  let enc: string;
  try { enc = encryptSecret(value, secretKey); } catch (x) { throw new CollabError(503, x instanceof Error ? x.message : "encryption failed"); }
  db.prepare(`INSERT INTO team_provider_secrets (tenant_id, engine, name, value_enc, set_at, set_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, engine, name) DO UPDATE SET value_enc = excluded.value_enc, set_at = excluded.set_at, set_by = excluded.set_by`).run(t, engine, name, enc, now, by);
}

/** Set / replace (string) or delete (null) one credential slot of a built-in provider. System admins only. */
export function setCredential(db: DB, u: Admin, engine: unknown, name: unknown, value: unknown, secretKey: string | undefined, env: (n: string) => string | undefined, now = Date.now()): CredentialView {
  requireManager(u, "provider credentials");
  const spec = PROVIDER_AUTH[engine as keyof typeof PROVIDER_AUTH];
  if (!spec || typeof engine !== "string" || !Object.hasOwn(PROVIDER_AUTH, engine)) throw new CollabError(404, `unknown provider '${String(engine)}'`);
  const slot = spec.slots.find((s) => s.name === name);
  if (!slot) throw new CollabError(400, `${spec.label} has no credential '${String(name)}' (has: ${spec.slots.map((s) => s.name).join(", ")})`);
  const t = u.tenantId, existed = !!row(db, t, engine, slot.name);
  if (value === null || value === "") {
    if (!existed) throw new CollabError(404, `${slot.name} is not stored`);
    db.prepare("DELETE FROM team_provider_secrets WHERE tenant_id = ? AND engine = ? AND name = ?").run(t, engine, slot.name);
    audit(db, u, engine, `${slot.name} deleted`, now);
  } else {
    const v = isCodexLogin(engine, slot.name) ? parseCodexLogin(value, now) : checkSecretValue(value, slot.label);
    writeSecret(db, t, engine, slot.name, v, secretKey, u.email, now);
    audit(db, u, engine, `${slot.name} ${existed ? "replaced" : "set"}`, now);
  }
  return credentialViews(db, t, engine as keyof typeof PROVIDER_AUTH, secretKey, env, true).find((c) => c.name === slot.name)!;
}

export function getAuthMode(db: DB, t: number, engine: string): { mode: AuthMode; updatedAt: number | null; updatedBy: string | null } {
  const r = db.prepare("SELECT mode, updated_at, updated_by FROM team_provider_auth WHERE tenant_id = ? AND engine = ?").get(t, engine) as { mode: AuthMode; updated_at: number; updated_by: string | null } | undefined;
  const spec = PROVIDER_AUTH[engine as keyof typeof PROVIDER_AUTH];
  const mode = r && spec?.modes.includes(r.mode) ? r.mode : spec?.modes[0] ?? "auto";
  return { mode, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
}

export function setAuthMode(db: DB, u: Admin, engine: unknown, mode: unknown, now = Date.now()) {
  requireManager(u, "provider auth methods");
  if (typeof engine !== "string" || !Object.hasOwn(PROVIDER_AUTH, engine)) throw new CollabError(404, `unknown provider '${String(engine)}'`);
  const spec = PROVIDER_AUTH[engine as keyof typeof PROVIDER_AUTH];
  if (!spec.modes.includes(mode as AuthMode)) throw new CollabError(400, `${spec.label} supports: ${spec.modes.join(", ")}`);
  const old = getAuthMode(db, u.tenantId, engine).mode;
  db.prepare("INSERT INTO team_provider_auth (tenant_id, engine, mode, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, engine) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by").run(u.tenantId, engine, mode as string, now, u.email);
  audit(db, u, engine, `auth method ${old} -> ${String(mode)}`, now);
  return getAuthMode(db, u.tenantId, engine);
}

/** Save the auth.json the codex CLI rewrote during a run (it refreshed the tokens). Audited as the CLI, not a user. */
export function saveRefreshedCodexLogin(db: DB, t: number, value: string, secretKey: string | undefined, now = Date.now()) {
  writeSecret(db, t, "codex", CODEX_LOGIN_SLOT, parseCodexLogin(value, now), secretKey, "codex (auto-refresh)", now);
  db.prepare("INSERT INTO provider_audit (tenant_id, actor_id, actor_email, engine, at, detail) VALUES (?, NULL, ?, 'codex', ?, ?)").run(t, "codex (auto-refresh)", now, `${CODEX_LOGIN_SLOT} refreshed by the codex CLI during a run`);
}

/** True when the server has a Codex ChatGPT login file (read-only check; the file is never read here). */
export const codexServerLogin = (home = process.env.HOME ?? "") => !!home && existsSync(path.join(home, ".codex", "auth.json"));

/** codexLogin: the stored ChatGPT login; the runner writes it as auth.json into a per-run CODEX_HOME. */
export type RunAuth = { env: Record<string, string>; unset: string[]; note: string; codexLogin?: string };

/** Per-run auth env for Claude Code and Codex from the chosen method (throws a clear error when missing). */
export function runAuth(engine: "claude-code" | "codex", mode: AuthMode, cred: (name: string) => string | undefined, serverLogin: boolean, cliLogin = true): RunAuth {
  if (engine === "claude-code") {
    const oauth = cred("CLAUDE_CODE_OAUTH_TOKEN"), key = cred("ANTHROPIC_API_KEY");
    const useSub = mode === "subscription" || (mode === "auto" && !!oauth);
    if (useSub) {
      if (!oauth) throw new Error("Claude Code is set to Subscription but no CLAUDE_CODE_OAUTH_TOKEN is stored: a team member pastes one from `claude setup-token` in Settings > Providers");
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: oauth }, unset: ["ANTHROPIC_API_KEY"], note: "claude-code: using the subscription token" };
    }
    if (key) return { env: { ANTHROPIC_API_KEY: key }, unset: ["CLAUDE_CODE_OAUTH_TOKEN"], note: "claude-code: using the API key" };
    if (mode === "api_key") throw new Error("Claude Code is set to API key but no ANTHROPIC_API_KEY is stored: a team member sets it in Settings > Providers");
    if (!cliLogin) throw new Error(noCredential("Claude Code needs an ANTHROPIC_API_KEY or a CLAUDE_CODE_OAUTH_TOKEN"));
    return { env: {}, unset: [], note: "claude-code: no stored credential; using the CLI's own login" };
  }
  const key = cred("CODEX_API_KEY"), token = cred("CODEX_ACCESS_TOKEN");
  if (mode === "api_key" || (mode === "auto" && key && !token && !serverLogin)) {
    if (!key) throw new Error("Codex is set to API key but no CODEX_API_KEY is stored: a team member sets it in Settings > Providers");
    return { env: { CODEX_API_KEY: key }, unset: ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"], note: "codex: using the API key" };
  }
  if (token) return { env: {}, unset: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"], codexLogin: token, note: "codex: using the team's stored ChatGPT login (auth.json in a per-run CODEX_HOME)" };
  if (!serverLogin && mode === "subscription") throw new Error("Codex is set to Subscription but no ChatGPT login is stored: a team member pastes ~/.codex/auth.json (from `codex login`) in Settings > Providers");
  if (!cliLogin) throw new Error(noCredential("Codex needs an OpenAI API key or a ChatGPT login"));
  return { env: {}, unset: ["CODEX_API_KEY", "OPENAI_API_KEY"], note: "codex: using the server's ChatGPT login" };
}

// ---- Custom providers: removed from the MVP build. Existing team_custom_providers rows stay in the DB
// (untouched, so other branches can be redeployed); they are only read here to redact stored keys from logs.
// OpenCode's native custom-provider support (opencode.ai/docs/providers, "Custom provider"): a provider entry
// with npm "@ai-sdk/openai-compatible", options.baseURL and a models map in opencode.json. Cobra writes that
// file into each run's isolated XDG_CONFIG_HOME; the key reaches OpenCode only as an env var ({env:NAME}).
// Verified on nova (opencode-ai 1.19.4, 2026-10-26): `opencode models <id>` lists <id>/<model> from such a config.
export const CUSTOM_ENGINE = (id: string) => `custom:${id}`;
export const CUSTOM_KEY = "API_KEY";

export type CustomProvider = { id: string; name: string; baseUrl: string; models: string[]; createdAt: number; createdBy: string | null; updatedAt: number; updatedBy: string | null };
export type CustomProviderView = CustomProvider & { key: CredentialView };

const parseModels = (s: string): string[] => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((m): m is string => typeof m === "string") : []; } catch { return []; } };

export function listCustomProviders(db: DB, t: number): CustomProvider[] {
  return (db.prepare("SELECT id, name, base_url baseUrl, models, created_at createdAt, created_by createdBy, updated_at updatedAt, updated_by updatedBy FROM team_custom_providers WHERE tenant_id = ? ORDER BY id").all(t) as Array<Omit<CustomProvider, "models"> & { models: string }>)
    .map((r) => ({ ...r, models: parseModels(r.models) }));
}

export const customEnvName = (id: string) => `COBRA_CP_${id.toUpperCase().replace(/-/g, "_")}_KEY`;

/** The team's stored custom-provider keys (for run-log redaction). */
export const customProviderSecrets = (db: DB, t: number, secretKey: string | undefined) =>
  listCustomProviders(db, t).map((p) => storedCredential(db, t, CUSTOM_ENGINE(p.id), CUSTOM_KEY, secretKey)).filter((v): v is string => !!v);

/** The team's stored built-in credentials (for run-log redaction). */
export const builtinCredentialSecrets = (db: DB, t: number, secretKey: string | undefined) =>
  (Object.keys(PROVIDER_AUTH) as Array<keyof typeof PROVIDER_AUTH>).flatMap((e) => PROVIDER_AUTH[e].slots.flatMap((s) => { const v = storedCredential(db, t, e, s.name, secretKey); return isCodexLogin(e, s.name) ? codexLoginSecrets(v) : v ? [v] : []; }));
