// Job 23: per-agent model choices, one list per engine. null/"" = the engine's own default.
//
// claude-code (Claude Code 2.1.310 on the server; `claude --help`: "--model <model> Model for the
//   current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a
//   model's full name"). Aliases and IDs from https://code.claude.com/docs/en/model-config
//   (checked 2026-10-25): sonnet, opus, haiku, fable resolve to the newest version (Anthropic API:
//   Sonnet 5.5, Opus 5.5, Haiku 5.5, Fable 5.1); full IDs pin a version. `default` is the account
//   default (Opus 5.5 on the API) and is what Cobra uses when no model is set.
// codex (codex-cli 0.164.0; `codex exec --help`: "-m, --model <MODEL> Model the agent should use").
//   IDs from the CLI's ~/.codex/models_cache.json on the server (visibility "list"), matching
//   https://developers.openai.com/codex/models (checked 2026-10-25), which recommends gpt-6.1-sol
//   and lists gpt-6-astra, gpt-6-sol, gpt-6-luna, and GPT-5.6 Sol/Terra/Luna still available.
//
// MVP build: Claude Code and Codex only (OpenCode, Cursor and OpenRouter removed).
//
// Override per server with COBRA_CLAUDE_MODELS / COBRA_CODEX_MODELS (comma-separated).
import { ENGINES, type Engine as AgentEngine } from "./engines";

export const MODEL_SOURCES = {
  "claude-code": "claude --help (2.1.310) + code.claude.com/docs/en/model-config, 2026-10-25",
  codex: "codex exec --help (0.164.0) + ~/.codex/models_cache.json + developers.openai.com/codex/models, 2026-10-25",
} as const;

export const DEFAULT_MODELS: Record<AgentEngine, readonly string[]> = {
  "claude-code": ["sonnet", "opus", "haiku", "fable", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
};

export const MODEL_ENV: Record<AgentEngine, string> = { "claude-code": "COBRA_CLAUDE_MODELS", codex: "COBRA_CODEX_MODELS" };
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;

/** Allowed model ids for an engine (env override first). The third argument is ignored (kept for call compatibility). */
export function modelsFor(engine: AgentEngine, env: Record<string, string | undefined> = process.env, _custom: readonly string[] = []): string[] {
  const o = env[MODEL_ENV[engine]]?.split(",").map((s) => s.trim()).filter((s) => SAFE.test(s));
  return [...new Set(o?.length ? o : DEFAULT_MODELS[engine])];
}
export const modelAllowed = (engine: AgentEngine, m: string, env: Record<string, string | undefined> = process.env, custom: readonly string[] = []) => modelsFor(engine, env, custom).includes(m);
export const allModels = (env: Record<string, string | undefined> = process.env, custom: readonly string[] = []) => Object.fromEntries(ENGINES.map((e) => [e, modelsFor(e, env, custom)])) as Record<AgentEngine, string[]>;

/** null for "default"; throws a message when the model isn't allowed for the engine. */
export function checkModel(engine: AgentEngine, model: unknown, env: Record<string, string | undefined> = process.env, custom: readonly string[] = []): string | null {
  if (model === undefined || model === null || model === "" || model === "default") return null;
  if (typeof model !== "string") throw new Error("model must be a string or null");
  const list = modelsFor(engine, env, custom);
  if (!modelAllowed(engine, model.trim(), env, custom)) throw new Error(`model '${model}' is not available for ${engine} (allowed: ${list.join(", ")}, or default)`);
  return model.trim();
}

/** CLI flags for the model; empty for the engine default. codex exec -m <id>; claude -p --model <id>. */
export function modelArgs(driver: AgentEngine, model: string | null | undefined): string[] {
  if (!model) return [];
  if (!SAFE.test(model)) throw new Error(`invalid model id '${model}'`);
  return driver === "codex" ? ["-m", model] : ["--model", model];
}
