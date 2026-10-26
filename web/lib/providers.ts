// Settings > Providers: the coding-agent CLIs Cobra runs, their models and effort tiers, and the
// system-wide defaults a system admin may set (default model + default effort per provider).
//
// Effort tiers, verified on the server (nova) 2026-10-25:
//   claude-code: `claude --help` (2.1.310): "--effort <level>  Effort level for the current session
//     (low, medium, high, xhigh, max)". Cobra passes `--effort <tier>`.
//   codex: `codex exec --help` (0.164.0) has no effort flag; "-c, --config <key=value> Override a
//     configuration value that would otherwise be loaded from ~/.codex/config.toml". The key is
//     model_reasoning_effort; every listed model in ~/.codex/models_cache.json supports low, medium,
//     high, xhigh, max (some also ultra). Cobra passes `-c model_reasoning_effort="<tier>"`.
//   opencode: `opencode run --help` (1.19.4): "--variant  model variant (provider-specific reasoning
//     effort, e.g., high, max, minimal)". `opencode models openai --verbose` lists variants none, low,
//     medium, high, xhigh (max on GPT-5.6/6) for every listed model. Cobra passes `--variant <tier>`.
//   cursor: `cursor-agent --help` (2026.10.22-27dcf5f) has no effort flag (only per-model bracket
//     parameters on some models, unverifiable without CURSOR_API_KEY), so effort is Not supported: the
//     page shows that and setting a tier for cursor is rejected with 400.
// Cobra offers the three tiers the CLIs accept for every model: low, medium, high (null = no flag,
// the CLI's own default). "Simulated" is a run mode (nothing executes), not a provider.
//
// Defaults apply at run time only (lib/workflows/local-runner.ts): an agent without a model uses the
// provider default model; the effort tier is passed as the flag above. They are not part of an
// agent's content hash, so changing them never changes agent hashes or invalidates approvals.
import type { DB } from "./db";
import { AGENT_ENGINES, type AgentEngine } from "./agents";
import { checkModel, modelAllowed, modelsFor, MODEL_SOURCES } from "./agent-models";
import { CollabError, isSystemAdmin } from "./collab";
import { decryptSecret, encryptSecret } from "./secret-box";

export const EFFORT_TIERS = ["low", "medium", "high"] as const;
export type EffortTier = (typeof EFFORT_TIERS)[number];

export const PROVIDERS: Record<AgentEngine, { label: string; cli: string; modelFlag: string; effortFlag: string; effortSource: string; cliTiers: string; tiers: readonly EffortTier[] }> = {
  "claude-code": { label: "Claude Code", cli: "claude -p (2.1.310)", modelFlag: "--model <id>", effortFlag: "--effort <tier>", effortSource: "claude --help (2.1.310)", cliTiers: "low, medium, high, xhigh, max", tiers: EFFORT_TIERS },
  codex: { label: "Codex", cli: "codex exec (0.164.0)", modelFlag: "-m <id>", effortFlag: "-c model_reasoning_effort=\"<tier>\"", effortSource: "codex exec --help (0.164.0) -c/--config + ~/.codex/models_cache.json", cliTiers: "low, medium, high, xhigh, max (ultra on some models)", tiers: EFFORT_TIERS },
  opencode: { label: "OpenCode", cli: "opencode run (1.19.4)", modelFlag: "-m <provider/model>", effortFlag: "--variant <tier>", effortSource: "opencode run --help + opencode models openai --verbose (1.19.4)", cliTiers: "none, low, medium, high, xhigh (max on some models)", tiers: EFFORT_TIERS },
  cursor: { label: "Cursor", cli: "cursor-agent -p (2026.10.22-27dcf5f)", modelFlag: "--model <id>", effortFlag: "none", effortSource: "cursor-agent --help (2026.10.22-27dcf5f): no effort flag", cliTiers: "none (no effort flag)", tiers: [] },
};

export type ProviderDefaults = { model: string | null; effort: EffortTier | null };
export type ProviderView = { engine: AgentEngine; label: string; cli: string; models: string[]; modelSource: string; modelFlag: string; tiers: readonly EffortTier[]; effortFlag: string; effortSource: string; cliTiers: string; defaults: ProviderDefaults; updatedAt: number | null; updatedBy: string | null };

/** Effort tiers Cobra offers for an engine (empty = Not supported). */
export const tiersFor = (engine: AgentEngine): readonly EffortTier[] => PROVIDERS[engine].tiers;

export function effortArgs(engine: AgentEngine, effort: string | null | undefined): string[] {
  if (!effort) return [];
  if (!(tiersFor(engine) as readonly string[]).includes(effort)) throw new Error(tiersFor(engine).length ? `invalid effort tier '${effort}'` : `${PROVIDERS[engine].label} has no effort tiers`);
  if (engine === "codex") return ["-c", `model_reasoning_effort="${effort}"`];
  if (engine === "opencode") return ["--variant", effort];
  return ["--effort", effort];
}

type Row = { engine: string; model: string | null; effort: string | null; updated_at: number; updated_by: string | null };
const row = (db: DB, e: AgentEngine) => db.prepare("SELECT engine, model, effort, updated_at, updated_by FROM provider_defaults WHERE engine = ?").get(e) as Row | undefined;

/** Stored defaults; a stored model no longer allowed (env override changed) reads as null. */
export function getProviderDefaults(db: DB, engine: AgentEngine, env: Record<string, string | undefined> = process.env): ProviderDefaults {
  const r = row(db, engine);
  if (!r) return { model: null, effort: null };
  const model = r.model && modelAllowed(engine, r.model, env) ? r.model : null;
  const effort = r.effort && (tiersFor(engine) as readonly string[]).includes(r.effort) ? (r.effort as EffortTier) : null;
  return { model, effort };
}

export function listProviders(db: DB, env: Record<string, string | undefined> = process.env): ProviderView[] {
  return AGENT_ENGINES.map((e) => {
    const p = PROVIDERS[e], r = row(db, e);
    return { engine: e, label: p.label, cli: p.cli, models: modelsFor(e, env), modelSource: MODEL_SOURCES[e], modelFlag: p.modelFlag, tiers: p.tiers, effortFlag: p.effortFlag, effortSource: p.effortSource, cliTiers: p.cliTiers, defaults: getProviderDefaults(db, e, env), updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
  });
}

export type Admin = { id: number; email: string; role: string };

/** System admins only. Body: { model?: string|null|"default", effort?: tier|null|"default" }; omitted = keep. */
export function setProviderDefaults(db: DB, u: Admin, engine: unknown, b: { model?: unknown; effort?: unknown } | null, now = Date.now(), env: Record<string, string | undefined> = process.env): ProviderDefaults {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can change provider defaults");
  if (!AGENT_ENGINES.includes(engine as AgentEngine)) throw new CollabError(404, `unknown provider '${String(engine)}'`);
  const e = engine as AgentEngine;
  if (!b || typeof b !== "object" || (b.model === undefined && b.effort === undefined)) throw new CollabError(400, "send model and/or effort");
  const cur = getProviderDefaults(db, e, env);
  let model = cur.model, effort = cur.effort;
  if (b.model !== undefined) { try { model = checkModel(e, b.model, env); } catch (x) { throw new CollabError(400, (x as Error).message); } }
  if (b.effort !== undefined) {
    if (b.effort === null || b.effort === "" || b.effort === "default") effort = null;
    else if (!tiersFor(e).length) throw new CollabError(400, `${PROVIDERS[e].label} has no effort tiers (Not supported); only default is allowed`);
    else if (typeof b.effort === "string" && (tiersFor(e) as readonly string[]).includes(b.effort)) effort = b.effort as EffortTier;
    else throw new CollabError(400, `effort must be one of ${tiersFor(e).join(", ")} or default`);
  }
  if (model === cur.model && effort === cur.effort) return cur;
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO provider_defaults (engine, model, effort, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(engine) DO UPDATE SET model = excluded.model, effort = excluded.effort, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(e, model, effort, now, u.email);
    db.prepare("INSERT INTO provider_audit (actor_id, actor_email, engine, old_model, new_model, old_effort, new_effort, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(u.id, u.email, e, cur.model, model, cur.effort, effort, now);
    db.exec("COMMIT");
  } catch (x) { db.exec("ROLLBACK"); throw x; }
  return { model, effort };
}

export function listProviderAudit(db: DB, limit = 20) {
  return db.prepare("SELECT actor_email actorEmail, engine, old_model oldModel, new_model newModel, old_effort oldEffort, new_effort newEffort, detail, at FROM provider_audit ORDER BY at DESC, id DESC LIMIT ?").all(limit)
    .map((r) => ({ ...(r as object) })) as Array<{ actorEmail: string; engine: string; oldModel: string | null; newModel: string | null; oldEffort: string | null; newEffort: string | null; detail: string | null; at: number }>;
}

// Per-provider secrets (migration 16): only the Cursor CLI needs one, CURSOR_API_KEY. Stored AES-256-GCM
// encrypted with COBRA_SECRET_KEY (lib/secret-box.ts, same as per-repo PATs); system admins only; the value
// is never returned to any client (views get set / not set), and runs pass it to the CLI as an env var
// and redact it from logs.
export const PROVIDER_SECRETS: Partial<Record<AgentEngine, { name: string; label: string; help: string }>> = {
  // OpenCode as its own provider (independent of OpenRouter): the OpenCode Console / Zen key. Verified on nova
  // (opencode-ai 1.19.4, 2026-10-26): with OPENCODE_API_KEY in env, `opencode models opencode` lists the paid
  // opencode/<model> ids; without it only the *-free ones (and big-pickle). Docs: opencode.ai/docs/zen.
  opencode: { name: "OPENCODE_API_KEY", label: "OpenCode API key", help: "From opencode.ai (Console / Zen) > API keys. Passed to opencode run as OPENCODE_API_KEY for opencode/<model> models. Independent of the OpenRouter key." },
  cursor: { name: "CURSOR_API_KEY", label: "Cursor API key", help: "From cursor.com/dashboard > Integrations > API keys. Passed to cursor-agent as CURSOR_API_KEY." },
};
export type ProviderSecretView = { engine: AgentEngine; name: string; label: string; help: string; set: boolean; setAt: number | null; setBy: string | null };

export function providerSecretStatus(db: DB, engine: AgentEngine): ProviderSecretView | null {
  const s = PROVIDER_SECRETS[engine];
  if (!s) return null;
  const r = db.prepare("SELECT set_at, set_by FROM provider_secrets WHERE engine = ? AND name = ?").get(engine, s.name) as { set_at: number; set_by: string | null } | undefined;
  return { engine, ...s, set: !!r, setAt: r?.set_at ?? null, setBy: r?.set_by ?? null };
}

/** Decrypted secret for a run, or undefined (not set / undecryptable). Never log the result. */
export function getProviderSecret(db: DB, engine: AgentEngine, secretKey: string | undefined): string | undefined {
  const s = PROVIDER_SECRETS[engine];
  if (!s) return undefined;
  const r = db.prepare("SELECT value_enc FROM provider_secrets WHERE engine = ? AND name = ?").get(engine, s.name) as { value_enc: string } | undefined;
  if (!r) return undefined;
  try { return decryptSecret(r.value_enc, secretKey); } catch { console.error(`[cobra] the stored ${s.name} can't be decrypted (COBRA_SECRET_KEY changed?)`); return undefined; }
}

/** Every decrypted provider secret (for run-log redaction). */
export function providerSecretValues(db: DB, secretKey: string | undefined): string[] {
  return AGENT_ENGINES.map((e) => getProviderSecret(db, e, secretKey)).filter((v): v is string => !!v);
}

/** System admins only. value: the new secret, or null/"" to clear. Returns the status (never the value). */
export function setProviderSecret(db: DB, u: Admin, engine: unknown, value: unknown, secretKey: string | undefined, now = Date.now()): ProviderSecretView {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can change provider secrets");
  if (!AGENT_ENGINES.includes(engine as AgentEngine)) throw new CollabError(404, `unknown provider '${String(engine)}'`);
  const e = engine as AgentEngine, s = PROVIDER_SECRETS[e];
  if (!s) throw new CollabError(400, `${PROVIDERS[e].label} has no secret to set`);
  if (value === null || value === "") {
    db.prepare("DELETE FROM provider_secrets WHERE engine = ? AND name = ?").run(e, s.name);
  } else {
    if (typeof value !== "string") throw new CollabError(400, "value must be a string, or null to clear");
    const v = value.trim();
    if (v.length < 8 || v.length > 500 || /\s/.test(v)) throw new CollabError(400, `${s.label} looks invalid (8-500 characters, no spaces)`);
    let enc: string;
    try { enc = encryptSecret(v, secretKey); } catch (x) { throw new CollabError(503, x instanceof Error ? x.message : "encryption failed"); }
    db.prepare(`INSERT INTO provider_secrets (engine, name, value_enc, set_at, set_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(engine, name) DO UPDATE SET value_enc = excluded.value_enc, set_at = excluded.set_at, set_by = excluded.set_by`).run(e, s.name, enc, now, u.email);
  }
  db.prepare("INSERT INTO provider_audit (actor_id, actor_email, engine, at, detail) VALUES (?, ?, ?, ?, ?)").run(u.id, u.email, e, now, `${s.name} ${value ? "set" : "cleared"}`);
  return providerSecretStatus(db, e)!;
}
