// OpenRouter: ONE shared, global API key for every team (not tenant-scoped). Stored AES-256-GCM encrypted
// (lib/secret-box.ts, COBRA_SECRET_KEY) in the global provider_secrets table as engine 'openrouter',
// name OPENROUTER_API_KEY, the same pattern as the Cursor key. System admins (role admin) only can set,
// replace or clear it; every set/clear is audited in provider_audit (who + when, never the value).
// Views carry set / not set only. COBRA_OPENROUTER_API_KEY in the server env file (or process env) is
// the fallback when no key is stored. Runs get the key per run only (lib/workflows/local-runner.ts).
// Pure Node (no Next imports) so tests can drive it.
import type { DB } from "./db";
import { CollabError, isSystemAdmin } from "./collab";
import { decryptSecret, encryptSecret } from "./secret-box";
import { ENGINE_LABEL, ENGINES, type Engine } from "./engines";
import { OPENROUTER_ENGINES, OPENROUTER_MODELS, supportsOpenRouter } from "./agent-models";

export const OPENROUTER = { id: "openrouter", name: "OPENROUTER_API_KEY", envFallback: "COBRA_OPENROUTER_API_KEY", label: "OpenRouter API key", help: "From openrouter.ai/settings/keys. One shared key for every team; passed per run only (OpenCode: OPENROUTER_API_KEY, Codex: per-run CODEX_HOME provider, Claude Code: ANTHROPIC_AUTH_TOKEN via https://openrouter.ai/api)." } as const;

export type OpenRouterView = { id: "openrouter"; name: string; label: string; help: string; set: boolean; source: "stored" | "env" | null; setAt: number | null; setBy: string | null; engines: Array<{ engine: Engine; label: string; supported: boolean }>; models: string[] };

const stored = (db: DB) => db.prepare("SELECT value_enc, set_at, set_by FROM provider_secrets WHERE engine = ? AND name = ?").get(OPENROUTER.id, OPENROUTER.name) as { value_enc: string; set_at: number; set_by: string | null } | undefined;

/** Status for any signed-in viewer: configured or not, never the value. */
export function openRouterStatus(db: DB, envValue?: string): OpenRouterView {
  const r = stored(db);
  return {
    id: "openrouter", name: OPENROUTER.name, label: OPENROUTER.label, help: OPENROUTER.help,
    set: !!r || !!envValue, source: r ? "stored" : envValue ? "env" : null, setAt: r?.set_at ?? null, setBy: r?.set_by ?? null,
    engines: ENGINES.map((e) => ({ engine: e, label: ENGINE_LABEL[e], supported: supportsOpenRouter(e) })),
    models: [...OPENROUTER_MODELS],
  };
}

/** The one global key for a run (any team): stored key, else the env fallback. Never log the result. */
export function getOpenRouterKey(db: DB, secretKey: string | undefined, envValue?: string): string | undefined {
  const r = stored(db);
  if (r) {
    try { return decryptSecret(r.value_enc, secretKey); } catch { console.error(`[cobra] the stored ${OPENROUTER.name} can't be decrypted (COBRA_SECRET_KEY changed?)`); }
  }
  return envValue?.trim() || undefined;
}

/** System admins only. value: the new key, or null/"" to clear. Returns the status (never the value). */
export function setOpenRouterKey(db: DB, u: { id: number; email: string; role: string }, value: unknown, secretKey: string | undefined, now = Date.now(), envValue?: string): OpenRouterView {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can change the OpenRouter API key");
  if (value === null || value === "") {
    db.prepare("DELETE FROM provider_secrets WHERE engine = ? AND name = ?").run(OPENROUTER.id, OPENROUTER.name);
  } else {
    if (typeof value !== "string") throw new CollabError(400, "value must be a string, or null to clear");
    const v = value.trim();
    if (v.length < 8 || v.length > 500 || /\s/.test(v)) throw new CollabError(400, `${OPENROUTER.label} looks invalid (8-500 characters, no spaces)`);
    let enc: string;
    try { enc = encryptSecret(v, secretKey); } catch (x) { throw new CollabError(503, x instanceof Error ? x.message : "encryption failed"); }
    db.prepare(`INSERT INTO provider_secrets (engine, name, value_enc, set_at, set_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(engine, name) DO UPDATE SET value_enc = excluded.value_enc, set_at = excluded.set_at, set_by = excluded.set_by`).run(OPENROUTER.id, OPENROUTER.name, enc, now, u.email);
  }
  db.prepare("INSERT INTO provider_audit (actor_id, actor_email, engine, at, detail) VALUES (?, ?, ?, ?, ?)").run(u.id, u.email, OPENROUTER.id, now, `${OPENROUTER.name} ${value ? "set" : "cleared"}`);
  return openRouterStatus(db, envValue);
}

export { OPENROUTER_ENGINES };
