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
// Cobra offers the three tiers both CLIs accept for every model: low, medium, high (null = no flag,
// the CLI's own default). "Simulated" is a run mode (nothing executes), not a provider.
//
// Defaults apply at run time only (lib/workflows/local-runner.ts): an agent without a model uses the
// provider default model; the effort tier is passed as the flag above. They are not part of an
// agent's content hash, so changing them never changes agent hashes or invalidates approvals.
import type { DB } from "./db";
import { AGENT_ENGINES, type AgentEngine } from "./agents";
import { checkModel, modelsFor, MODEL_SOURCES } from "./agent-models";
import { CollabError, isSystemAdmin } from "./collab";

export const EFFORT_TIERS = ["low", "medium", "high"] as const;
export type EffortTier = (typeof EFFORT_TIERS)[number];

export const PROVIDERS: Record<AgentEngine, { label: string; cli: string; modelFlag: string; effortFlag: string; effortSource: string; cliTiers: string }> = {
  "claude-code": { label: "Claude Code", cli: "claude -p (2.1.310)", modelFlag: "--model <id>", effortFlag: "--effort <tier>", effortSource: "claude --help (2.1.310)", cliTiers: "low, medium, high, xhigh, max" },
  codex: { label: "Codex", cli: "codex exec (0.164.0)", modelFlag: "-m <id>", effortFlag: "-c model_reasoning_effort=\"<tier>\"", effortSource: "codex exec --help (0.164.0) -c/--config + ~/.codex/models_cache.json", cliTiers: "low, medium, high, xhigh, max (ultra on some models)" },
};

export type ProviderDefaults = { model: string | null; effort: EffortTier | null };
export type ProviderView = { engine: AgentEngine; label: string; cli: string; models: string[]; modelSource: string; modelFlag: string; tiers: readonly EffortTier[]; effortFlag: string; effortSource: string; cliTiers: string; defaults: ProviderDefaults; updatedAt: number | null; updatedBy: string | null };

export function effortArgs(engine: AgentEngine, effort: string | null | undefined): string[] {
  if (!effort) return [];
  if (!(EFFORT_TIERS as readonly string[]).includes(effort)) throw new Error(`invalid effort tier '${effort}'`);
  return engine === "codex" ? ["-c", `model_reasoning_effort="${effort}"`] : ["--effort", effort];
}

type Row = { engine: string; model: string | null; effort: string | null; updated_at: number; updated_by: string | null };
const row = (db: DB, e: AgentEngine) => db.prepare("SELECT engine, model, effort, updated_at, updated_by FROM provider_defaults WHERE engine = ?").get(e) as Row | undefined;

/** Stored defaults; a stored model no longer allowed (env override changed) reads as null. */
export function getProviderDefaults(db: DB, engine: AgentEngine, env: Record<string, string | undefined> = process.env): ProviderDefaults {
  const r = row(db, engine);
  if (!r) return { model: null, effort: null };
  const model = r.model && modelsFor(engine, env).includes(r.model) ? r.model : null;
  const effort = r.effort && (EFFORT_TIERS as readonly string[]).includes(r.effort) ? (r.effort as EffortTier) : null;
  return { model, effort };
}

export function listProviders(db: DB, env: Record<string, string | undefined> = process.env): ProviderView[] {
  return AGENT_ENGINES.map((e) => {
    const p = PROVIDERS[e], r = row(db, e);
    return { engine: e, label: p.label, cli: p.cli, models: modelsFor(e, env), modelSource: MODEL_SOURCES[e], modelFlag: p.modelFlag, tiers: EFFORT_TIERS, effortFlag: p.effortFlag, effortSource: p.effortSource, cliTiers: p.cliTiers, defaults: getProviderDefaults(db, e, env), updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
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
    else if (typeof b.effort === "string" && (EFFORT_TIERS as readonly string[]).includes(b.effort)) effort = b.effort as EffortTier;
    else throw new CollabError(400, `effort must be one of ${EFFORT_TIERS.join(", ")} or default`);
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
  return db.prepare("SELECT actor_email actorEmail, engine, old_model oldModel, new_model newModel, old_effort oldEffort, new_effort newEffort, at FROM provider_audit ORDER BY at DESC, id DESC LIMIT ?").all(limit)
    .map((r) => ({ ...(r as object) })) as Array<{ actorEmail: string; engine: string; oldModel: string | null; newModel: string | null; oldEffort: string | null; newEffort: string | null; at: number }>;
}
