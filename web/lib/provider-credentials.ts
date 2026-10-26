// Settings > Providers: unified credential manager (system admins only).
//
// Each built-in provider has credential slots by auth type. Values are stored AES-256-GCM encrypted
// (lib/secret-box.ts, COBRA_SECRET_KEY) in provider_secrets (engine, name); views carry set / not set,
// the last 4 characters, who and when, never the value. Every set / replace / delete and auth-method
// change is written to provider_audit. A stored value wins over the server env file (the env fallback).
//
// Auth types, verified on nova 2026-10-26 (CLI help + vendor docs):
//   Claude Code 2.1.310: API key ANTHROPIC_API_KEY; subscription CLAUDE_CODE_OAUTH_TOKEN from
//     `claude setup-token` ("Set up a long-lived authentication token (requires Claude subscription)").
//   Codex 0.164.0: API key CODEX_API_KEY (exec; takes precedence over any login); subscription is the
//     server's ChatGPT login (~/.codex/auth.json, `codex login`) or a pasted CODEX_ACCESS_TOKEN
//     (ChatGPT/Codex access token for trusted automation; `codex login --with-access-token`).
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

export type AuthType = "api_key" | "subscription";
export type AuthMode = "auto" | AuthType;
export type CredentialSlot = { name: string; type: AuthType; label: string; help: string };
export type ProviderAuthSpec = { id: string; label: string; slots: CredentialSlot[]; modes: AuthMode[]; noSubscription?: string; serverLogin?: string };

export const PROVIDER_AUTH: Record<AgentEngine | "openrouter", ProviderAuthSpec> = {
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
      { name: "CODEX_ACCESS_TOKEN", type: "subscription", label: "ChatGPT / Codex access token", help: "Optional: a ChatGPT/Codex access token for automation (see `codex login --with-access-token`). Without it, subscription runs use the server's ChatGPT login." },
    ],
  },
  opencode: {
    id: "opencode", label: "OpenCode", modes: ["api_key"],
    noSubscription: "OpenCode has no subscription login of its own. openai/* models reuse the Codex ChatGPT login; custom providers below use their own API keys.",
    slots: [{ name: "OPENCODE_API_KEY", type: "api_key", label: "OpenCode API key", help: "From opencode.ai (Console / Zen) > API keys. Passed to opencode run as OPENCODE_API_KEY for opencode/<model> models." }],
  },
  cursor: {
    id: "cursor", label: "Cursor", modes: ["api_key"],
    noSubscription: "Not supported: `cursor-agent login` is an interactive browser login Cobra can't use. Create the API key under your Cursor plan instead.",
    slots: [{ name: "CURSOR_API_KEY", type: "api_key", label: "Cursor API key", help: "From cursor.com/dashboard > Integrations > API keys. Passed to cursor-agent as CURSOR_API_KEY." }],
  },
  openrouter: {
    id: "openrouter", label: "OpenRouter", modes: ["api_key"],
    noSubscription: "OpenRouter is pay-as-you-go: API key only.",
    slots: [{ name: "OPENROUTER_API_KEY", type: "api_key", label: "OpenRouter API key", help: "From openrouter.ai/settings/keys. One shared key for every team (env fallback COBRA_OPENROUTER_API_KEY)." }],
  },
};

type Admin = { id: number; email: string; role: string };
export type CredentialView = CredentialSlot & { set: boolean; source: "stored" | "env" | null; last4: string | null; setAt: number | null; setBy: string | null };

const row = (db: DB, engine: string, name: string) =>
  db.prepare("SELECT value_enc, set_at, set_by FROM provider_secrets WHERE engine = ? AND name = ?").get(engine, name) as { value_enc: string; set_at: number; set_by: string | null } | undefined;
const tail = (v: string) => (v.length >= 12 ? v.slice(-4) : null);
const envName = (engine: string, name: string) => (engine === "openrouter" ? "COBRA_OPENROUTER_API_KEY" : name);

/** Stored value (decrypted) for a run; undefined when unset/undecryptable. Never log the result. */
export function storedCredential(db: DB, engine: string, name: string, secretKey: string | undefined): string | undefined {
  const r = row(db, engine, name);
  if (!r) return undefined;
  try { return decryptSecret(r.value_enc, secretKey); } catch { console.error(`[cobra] the stored ${name} for ${engine} can't be decrypted (COBRA_SECRET_KEY changed?)`); return undefined; }
}

/** Stored value, else the env fallback (same name in the server env file). */
export function resolveCredential(db: DB, engine: string, name: string, secretKey: string | undefined, env: (n: string) => string | undefined): string | undefined {
  return storedCredential(db, engine, name, secretKey) ?? (env(envName(engine, name))?.trim() || undefined);
}

export function credentialViews(db: DB, engine: keyof typeof PROVIDER_AUTH, secretKey: string | undefined, env: (n: string) => string | undefined, withDetail: boolean): CredentialView[] {
  return PROVIDER_AUTH[engine].slots.map((s) => {
    const r = row(db, engine, s.name);
    let last4: string | null = null;
    if (r && withDetail) { const v = storedCredential(db, engine, s.name, secretKey); last4 = v ? tail(v) : null; }
    const envSet = !r && !!env(envName(engine, s.name))?.trim();
    return { ...s, set: !!r || envSet, source: r ? "stored" : envSet ? "env" : null, last4, setAt: withDetail ? r?.set_at ?? null : null, setBy: withDetail ? r?.set_by ?? null : null };
  });
}

const audit = (db: DB, u: Admin, engine: string, detail: string, now: number) =>
  db.prepare("INSERT INTO provider_audit (actor_id, actor_email, engine, at, detail) VALUES (?, ?, ?, ?, ?)").run(u.id, u.email, engine, now, detail);

function requireAdmin(u: Admin, what: string) { if (!isSystemAdmin(u)) throw new CollabError(403, `only system admins can change ${what}`); }

export function checkSecretValue(v: unknown, label: string): string {
  if (typeof v !== "string") throw new CollabError(400, "value must be a string, or null to delete");
  const t = v.trim();
  if (t.length < 8 || t.length > 4000 || /\s/.test(t)) throw new CollabError(400, `${label} looks invalid (8-4000 characters, no spaces)`);
  return t;
}

function writeSecret(db: DB, engine: string, name: string, value: string, secretKey: string | undefined, by: string, now: number) {
  let enc: string;
  try { enc = encryptSecret(value, secretKey); } catch (x) { throw new CollabError(503, x instanceof Error ? x.message : "encryption failed"); }
  db.prepare(`INSERT INTO provider_secrets (engine, name, value_enc, set_at, set_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(engine, name) DO UPDATE SET value_enc = excluded.value_enc, set_at = excluded.set_at, set_by = excluded.set_by`).run(engine, name, enc, now, by);
}

/** Set / replace (string) or delete (null) one credential slot of a built-in provider. System admins only. */
export function setCredential(db: DB, u: Admin, engine: unknown, name: unknown, value: unknown, secretKey: string | undefined, env: (n: string) => string | undefined, now = Date.now()): CredentialView {
  requireAdmin(u, "provider credentials");
  const spec = PROVIDER_AUTH[engine as keyof typeof PROVIDER_AUTH];
  if (!spec || typeof engine !== "string" || !Object.hasOwn(PROVIDER_AUTH, engine)) throw new CollabError(404, `unknown provider '${String(engine)}'`);
  if (engine === "openrouter") throw new CollabError(400, "OpenRouter's key goes through its own path (lib/openrouter.ts)");
  const slot = spec.slots.find((s) => s.name === name);
  if (!slot) throw new CollabError(400, `${spec.label} has no credential '${String(name)}' (has: ${spec.slots.map((s) => s.name).join(", ")})`);
  const existed = !!row(db, engine, slot.name);
  if (value === null || value === "") {
    if (!existed) throw new CollabError(404, `${slot.name} is not stored`);
    db.prepare("DELETE FROM provider_secrets WHERE engine = ? AND name = ?").run(engine, slot.name);
    audit(db, u, engine, `${slot.name} deleted`, now);
  } else {
    writeSecret(db, engine, slot.name, checkSecretValue(value, slot.label), secretKey, u.email, now);
    audit(db, u, engine, `${slot.name} ${existed ? "replaced" : "set"}`, now);
  }
  return credentialViews(db, engine as keyof typeof PROVIDER_AUTH, secretKey, env, true).find((c) => c.name === slot.name)!;
}

export function getAuthMode(db: DB, engine: string): { mode: AuthMode; updatedAt: number | null; updatedBy: string | null } {
  const r = db.prepare("SELECT mode, updated_at, updated_by FROM provider_auth WHERE engine = ?").get(engine) as { mode: AuthMode; updated_at: number; updated_by: string | null } | undefined;
  const spec = PROVIDER_AUTH[engine as keyof typeof PROVIDER_AUTH];
  const mode = r && spec?.modes.includes(r.mode) ? r.mode : spec?.modes[0] ?? "auto";
  return { mode, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
}

export function setAuthMode(db: DB, u: Admin, engine: unknown, mode: unknown, now = Date.now()) {
  requireAdmin(u, "provider auth methods");
  if (typeof engine !== "string" || !Object.hasOwn(PROVIDER_AUTH, engine)) throw new CollabError(404, `unknown provider '${String(engine)}'`);
  const spec = PROVIDER_AUTH[engine as keyof typeof PROVIDER_AUTH];
  if (!spec.modes.includes(mode as AuthMode)) throw new CollabError(400, `${spec.label} supports: ${spec.modes.join(", ")}`);
  const old = getAuthMode(db, engine).mode;
  db.prepare("INSERT INTO provider_auth (engine, mode, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(engine) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by").run(engine, mode as string, now, u.email);
  audit(db, u, engine, `auth method ${old} -> ${String(mode)}`, now);
  return getAuthMode(db, engine);
}

/** True when the server has a Codex ChatGPT login file (read-only check; the file is never read here). */
export const codexServerLogin = (home = process.env.HOME ?? "") => !!home && existsSync(path.join(home, ".codex", "auth.json"));

export type RunAuth = { env: Record<string, string>; unset: string[]; note: string };

/** Per-run auth env for Claude Code and Codex from the chosen method (throws a clear error when missing). */
export function runAuth(engine: "claude-code" | "codex", mode: AuthMode, cred: (name: string) => string | undefined, serverLogin: boolean): RunAuth {
  if (engine === "claude-code") {
    const oauth = cred("CLAUDE_CODE_OAUTH_TOKEN"), key = cred("ANTHROPIC_API_KEY");
    const useSub = mode === "subscription" || (mode === "auto" && !!oauth);
    if (useSub) {
      if (!oauth) throw new Error("Claude Code is set to Subscription but no CLAUDE_CODE_OAUTH_TOKEN is stored: a system admin pastes one from `claude setup-token` in Settings > Providers");
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: oauth }, unset: ["ANTHROPIC_API_KEY"], note: "claude-code: using the subscription token" };
    }
    if (key) return { env: { ANTHROPIC_API_KEY: key }, unset: ["CLAUDE_CODE_OAUTH_TOKEN"], note: "claude-code: using the API key" };
    if (mode === "api_key") throw new Error("Claude Code is set to API key but no ANTHROPIC_API_KEY is stored: a system admin sets it in Settings > Providers");
    return { env: {}, unset: [], note: "claude-code: no stored credential; using the CLI's own login" };
  }
  const key = cred("CODEX_API_KEY"), token = cred("CODEX_ACCESS_TOKEN");
  if (mode === "api_key" || (mode === "auto" && key && !token && !serverLogin)) {
    if (!key) throw new Error("Codex is set to API key but no CODEX_API_KEY is stored: a system admin sets it in Settings > Providers");
    return { env: { CODEX_API_KEY: key }, unset: ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"], note: "codex: using the API key" };
  }
  if (token) return { env: { CODEX_ACCESS_TOKEN: token }, unset: ["CODEX_API_KEY", "OPENAI_API_KEY"], note: "codex: using the stored ChatGPT/Codex access token" };
  if (!serverLogin && mode === "subscription") throw new Error("Codex is set to Subscription but there's no ChatGPT login on the server and no CODEX_ACCESS_TOKEN is stored");
  return { env: {}, unset: ["CODEX_API_KEY", "OPENAI_API_KEY"], note: "codex: using the server's ChatGPT login" };
}

// ---- Custom providers (OpenAI-compatible, run on the OpenCode engine) ----
// OpenCode's native custom-provider support (opencode.ai/docs/providers, "Custom provider"): a provider entry
// with npm "@ai-sdk/openai-compatible", options.baseURL and a models map in opencode.json. Cobra writes that
// file into each run's isolated XDG_CONFIG_HOME; the key reaches OpenCode only as an env var ({env:NAME}).
// Verified on nova (opencode-ai 1.19.4, 2026-10-26): `opencode models <id>` lists <id>/<model> from such a config.
export const CUSTOM_ENGINE = (id: string) => `custom:${id}`;
export const CUSTOM_KEY = "API_KEY";
const RESERVED = new Set(["openai", "anthropic", "opencode", "openrouter", "google", "github-copilot", "amazon-bedrock", "azure", "xai", "groq", "mistral", "deepseek", "ollama", "lmstudio", "vercel", "cursor", "codex", "claude-code", "custom"]);
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export type CustomProvider = { id: string; name: string; baseUrl: string; models: string[]; createdAt: number; createdBy: string | null; updatedAt: number; updatedBy: string | null };
export type CustomProviderView = CustomProvider & { key: CredentialView };

const parseModels = (s: string): string[] => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((m): m is string => typeof m === "string") : []; } catch { return []; } };

export function listCustomProviders(db: DB): CustomProvider[] {
  return (db.prepare("SELECT id, name, base_url baseUrl, models, created_at createdAt, created_by createdBy, updated_at updatedAt, updated_by updatedBy FROM custom_providers ORDER BY id").all() as Array<Omit<CustomProvider, "models"> & { models: string }>)
    .map((r) => ({ ...r, models: parseModels(r.models) }));
}

export function customProviderViews(db: DB, secretKey: string | undefined, withDetail: boolean): CustomProviderView[] {
  return listCustomProviders(db).map((p) => {
    const r = row(db, CUSTOM_ENGINE(p.id), CUSTOM_KEY);
    let last4: string | null = null;
    if (r && withDetail) { const v = storedCredential(db, CUSTOM_ENGINE(p.id), CUSTOM_KEY, secretKey); last4 = v ? tail(v) : null; }
    return { ...p, key: { name: CUSTOM_KEY, type: "api_key", label: `${p.name} API key`, help: "", set: !!r, source: r ? "stored" : null, last4, setAt: withDetail ? r?.set_at ?? null : null, setBy: withDetail ? r?.set_by ?? null : null } };
  });
}

/** Every custom model id, as the OpenCode engine sees it: <provider id>/<model>. */
export const customModelIds = (db: DB): string[] => listCustomProviders(db).flatMap((p) => p.models.map((m) => `${p.id}/${m}`));

type CustomInput = { id?: unknown; name?: unknown; baseUrl?: unknown; models?: unknown; apiKey?: unknown };
function checkFields(b: CustomInput, partial: CustomProvider | null) {
  const name = b.name === undefined && partial ? partial.name : typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 60) throw new CollabError(400, "name is required (max 60 characters)");
  const baseUrl = b.baseUrl === undefined && partial ? partial.baseUrl : typeof b.baseUrl === "string" ? b.baseUrl.trim().replace(/\/+$/, "") : "";
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new CollabError(400, "base URL must be a full URL, e.g. https://api.example.com/v1"); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new CollabError(400, "base URL must use https (http only for localhost)");
  if (u.username || u.password) throw new CollabError(400, "don't put credentials in the base URL; use the API key field");
  const raw = b.models === undefined && partial ? partial.models : Array.isArray(b.models) ? b.models : typeof b.models === "string" ? b.models.split(/[\s,]+/) : [];
  const models = [...new Set(raw.map((m) => String(m).trim()).filter(Boolean))];
  if (!models.length || models.length > 50) throw new CollabError(400, "list 1-50 model ids");
  const bad = models.find((m) => !MODEL_RE.test(m));
  if (bad) throw new CollabError(400, `invalid model id '${bad}' (letters, digits, . _ : / -)`);
  return { name, baseUrl, models };
}

export function addCustomProvider(db: DB, u: Admin, b: CustomInput, secretKey: string | undefined, now = Date.now()): CustomProvider {
  requireAdmin(u, "custom providers");
  const id = typeof b.id === "string" ? b.id.trim() : "";
  if (!ID_RE.test(id)) throw new CollabError(400, "id must be 2-31 lowercase letters, digits or '-', starting with a letter");
  if (RESERVED.has(id)) throw new CollabError(400, `'${id}' is a built-in OpenCode provider id; pick another`);
  if (db.prepare("SELECT 1 FROM custom_providers WHERE id = ?").get(id)) throw new CollabError(409, `a custom provider '${id}' already exists`);
  const f = checkFields(b, null);
  const key = b.apiKey === undefined || b.apiKey === null || b.apiKey === "" ? null : checkSecretValue(b.apiKey, "API key");
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO custom_providers (id, name, base_url, models, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, f.name, f.baseUrl, JSON.stringify(f.models), now, u.email, now, u.email);
    if (key) writeSecret(db, CUSTOM_ENGINE(id), CUSTOM_KEY, key, secretKey, u.email, now);
    audit(db, u, CUSTOM_ENGINE(id), `custom provider added (${f.baseUrl}; ${f.models.length} models${key ? "; API key set" : ""})`, now);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return listCustomProviders(db).find((p) => p.id === id)!;
}

export function updateCustomProvider(db: DB, u: Admin, id: string, b: CustomInput, secretKey: string | undefined, now = Date.now()): CustomProvider {
  requireAdmin(u, "custom providers");
  const cur = listCustomProviders(db).find((p) => p.id === id);
  if (!cur) throw new CollabError(404, `no custom provider '${id}'`);
  const f = checkFields(b, cur);
  const changes: string[] = [];
  if (f.name !== cur.name) changes.push("name");
  if (f.baseUrl !== cur.baseUrl) changes.push(`base URL -> ${f.baseUrl}`);
  if (JSON.stringify(f.models) !== JSON.stringify(cur.models)) changes.push(`models -> ${f.models.length}`);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE custom_providers SET name = ?, base_url = ?, models = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(f.name, f.baseUrl, JSON.stringify(f.models), now, u.email, id);
    if (b.apiKey === null) {
      if (row(db, CUSTOM_ENGINE(id), CUSTOM_KEY)) { db.prepare("DELETE FROM provider_secrets WHERE engine = ? AND name = ?").run(CUSTOM_ENGINE(id), CUSTOM_KEY); changes.push("API key deleted"); }
    } else if (b.apiKey !== undefined && b.apiKey !== "") {
      const had = !!row(db, CUSTOM_ENGINE(id), CUSTOM_KEY);
      writeSecret(db, CUSTOM_ENGINE(id), CUSTOM_KEY, checkSecretValue(b.apiKey, "API key"), secretKey, u.email, now);
      changes.push(`API key ${had ? "replaced" : "set"}`);
    }
    audit(db, u, CUSTOM_ENGINE(id), `custom provider edited (${changes.join("; ") || "no changes"})`, now);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return listCustomProviders(db).find((p) => p.id === id)!;
}

export function deleteCustomProvider(db: DB, u: Admin, id: string, now = Date.now()): void {
  requireAdmin(u, "custom providers");
  const cur = listCustomProviders(db).find((p) => p.id === id);
  if (!cur) throw new CollabError(404, `no custom provider '${id}'`);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM custom_providers WHERE id = ?").run(id);
    db.prepare("DELETE FROM provider_secrets WHERE engine = ?").run(CUSTOM_ENGINE(id));
    audit(db, u, CUSTOM_ENGINE(id), "custom provider deleted (and its API key)", now);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

export const customEnvName = (id: string) => `COBRA_CP_${id.toUpperCase().replace(/-/g, "_")}_KEY`;

/** opencode.json for a run plus the env vars carrying the keys. Keys never appear in the file. */
export function opencodeCustomConfig(db: DB, secretKey: string | undefined): { config: Record<string, unknown> | null; env: Record<string, string>; secrets: string[] } {
  const ps = listCustomProviders(db);
  if (!ps.length) return { config: null, env: {}, secrets: [] };
  const env: Record<string, string> = {}, provider: Record<string, unknown> = {};
  for (const p of ps) {
    const key = storedCredential(db, CUSTOM_ENGINE(p.id), CUSTOM_KEY, secretKey);
    if (key) env[customEnvName(p.id)] = key;
    provider[p.id] = {
      npm: "@ai-sdk/openai-compatible", name: p.name,
      options: { baseURL: p.baseUrl, ...(key ? { apiKey: `{env:${customEnvName(p.id)}}` } : {}) },
      models: Object.fromEntries(p.models.map((m) => [m, { name: m }])),
    };
  }
  return { config: { $schema: "https://opencode.ai/config.json", provider }, env, secrets: Object.values(env) };
}

/** Every stored custom-provider key (for run-log redaction). */
export const customProviderSecrets = (db: DB, secretKey: string | undefined) =>
  listCustomProviders(db).map((p) => storedCredential(db, CUSTOM_ENGINE(p.id), CUSTOM_KEY, secretKey)).filter((v): v is string => !!v);

/** Every stored built-in credential (for run-log redaction). */
export const builtinCredentialSecrets = (db: DB, secretKey: string | undefined) =>
  (Object.keys(PROVIDER_AUTH) as Array<keyof typeof PROVIDER_AUTH>).flatMap((e) => PROVIDER_AUTH[e].slots.map((s) => storedCredential(db, e, s.name, secretKey))).filter((v): v is string => !!v);
