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
// opencode (opencode-ai 1.19.4 on the server; `opencode run --help`: "-m, --model  model to use in the
//   format of provider/model"). IDs from `opencode models openai` on nova (2026-10-25), which lists the
//   OpenAI models reachable with the ChatGPT login Cobra reuses from Codex (see local-runner.ts). Anthropic
//   models need ANTHROPIC_API_KEY (a Claude Code OAuth token is rejected), so none are listed by default.
// cursor (Cursor CLI `cursor-agent` 2026.10.22-27dcf5f; `cursor-agent --help`: "--model <model> Model to
//   use (e.g., gpt-5, sonnet-4-thinking)"). `cursor-agent models` needs CURSOR_API_KEY, which is not set
//   yet, so these IDs follow cursor.com/docs/models (checked 2026-10-25); `auto` lets Cursor pick. Verify
//   with `cursor-agent models` once the key is set and adjust with COBRA_CURSOR_MODELS.
//
// Override per server with COBRA_CLAUDE_MODELS / COBRA_CODEX_MODELS / COBRA_OPENCODE_MODELS /
// COBRA_CURSOR_MODELS (comma-separated).
import { ENGINES, type Engine as AgentEngine } from "./engines";

// OpenRouter (one shared, global API key; Settings > Providers). A model id "openrouter/<vendor>/<model>"
// on a supported engine routes that run through OpenRouter. Ids checked against the public
// https://openrouter.ai/api/v1/models on 2026-10-25. Per engine (docs checked 2026-10-25):
//   opencode: native OpenRouter provider (opencode.ai/docs/providers), model "openrouter/<vendor>/<model>",
//     key in OPENROUTER_API_KEY.
//   codex: custom model_provider in a per-run CODEX_HOME/config.toml, base_url https://openrouter.ai/api/v1,
//     env_key OPENROUTER_API_KEY (openrouter.ai/docs/guides/guides/codex-cli). wire_api is left at its
//     default: the Codex config reference says "responses is the only supported value" (no "chat").
//   claude-code: OpenRouter's Anthropic-compatible API (openrouter.ai/docs/guides/guides/claude-code-integration):
//     ANTHROPIC_BASE_URL=https://openrouter.ai/api, ANTHROPIC_AUTH_TOKEN=<key>, ANTHROPIC_API_KEY="".
//   cursor: cursor-agent has no custom base URL / provider option, so OpenRouter is Not supported.
export const OPENROUTER_PREFIX = "openrouter/";
export const OPENROUTER_ENGINES = ["claude-code", "codex", "opencode"] as const satisfies readonly AgentEngine[];
export const OPENROUTER_MODELS: readonly string[] = [
  "anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5",
  "openai/gpt-5", "openai/gpt-5.6-sol", "google/gemini-2.5-pro", "deepseek/deepseek-v4-pro", "qwen/qwen3-coder",
  "x-ai/grok-4.7", "moonshotai/kimi-k3", "z-ai/glm-5.3",
];
const OR_ID = /^openrouter\/[a-z0-9][a-z0-9._-]{0,49}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
export const supportsOpenRouter = (e: AgentEngine) => (OPENROUTER_ENGINES as readonly string[]).includes(e);
export const isOpenRouterModel = (m: string | null | undefined): m is string => !!m && m.startsWith(OPENROUTER_PREFIX);
/** "openrouter/anthropic/claude-sonnet-4.5" -> "anthropic/claude-sonnet-4.5" (the id OpenRouter expects). */
export const openRouterSlug = (m: string) => m.slice(OPENROUTER_PREFIX.length);
/** Curated OpenRouter picker entries for an engine (Claude Code: Anthropic models only; custom ids still allowed). */
export function openRouterModelsFor(engine: AgentEngine): string[] {
  if (!supportsOpenRouter(engine)) return [];
  return OPENROUTER_MODELS.filter((m) => engine !== "claude-code" || m.startsWith("anthropic/")).map((m) => OPENROUTER_PREFIX + m);
}
/** A free-text custom OpenRouter model id is valid for this engine. */
export const isValidOpenRouterId = (engine: AgentEngine, m: string) => supportsOpenRouter(engine) && OR_ID.test(m);

export const MODEL_SOURCES = {
  "claude-code": "claude --help (2.1.310) + code.claude.com/docs/en/model-config, 2026-10-25",
  codex: "codex exec --help (0.164.0) + ~/.codex/models_cache.json + developers.openai.com/codex/models, 2026-10-25",
  opencode: "opencode run --help + opencode models openai (opencode-ai 1.19.4), 2026-10-25",
  cursor: "cursor-agent --help (2026.10.22-27dcf5f) + cursor.com/docs/models, 2026-10-25 (cursor-agent models needs CURSOR_API_KEY)",
} as const;

export const DEFAULT_MODELS: Record<AgentEngine, readonly string[]> = {
  "claude-code": ["sonnet", "opus", "haiku", "fable", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  opencode: ["openai/gpt-6.1-sol", "openai/gpt-6-sol", "openai/gpt-6-astra", "openai/gpt-6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "openai/gpt-5.5"],
  cursor: ["auto", "composer-2.5", "grok-4.7", "claude-sonnet-5-5", "claude-opus-5-5", "gpt-5.6-sol", "gpt-5.6-terra", "gemini-3.1-pro"],
};

export const MODEL_ENV: Record<AgentEngine, string> = { "claude-code": "COBRA_CLAUDE_MODELS", codex: "COBRA_CODEX_MODELS", opencode: "COBRA_OPENCODE_MODELS", cursor: "COBRA_CURSOR_MODELS" };
const ENV = MODEL_ENV;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;

/** Allowed model ids for an engine (env override first). */
export function modelsFor(engine: AgentEngine, env: Record<string, string | undefined> = process.env): string[] {
  const o = env[ENV[engine]]?.split(",").map((s) => s.trim()).filter((s) => SAFE.test(s));
  return o?.length ? [...new Set(o)] : [...DEFAULT_MODELS[engine], ...openRouterModelsFor(engine)];
}
/** Listed, or a custom openrouter/<vendor>/<model> id on an engine that supports OpenRouter. */
export const modelAllowed = (engine: AgentEngine, m: string, env: Record<string, string | undefined> = process.env) => modelsFor(engine, env).includes(m) || isValidOpenRouterId(engine, m);
export const allModels = (env: Record<string, string | undefined> = process.env) => Object.fromEntries(ENGINES.map((e) => [e, modelsFor(e, env)])) as Record<AgentEngine, string[]>;

/** null for "default"; throws a message when the model isn't allowed for the engine. */
export function checkModel(engine: AgentEngine, model: unknown, env: Record<string, string | undefined> = process.env): string | null {
  if (model === undefined || model === null || model === "" || model === "default") return null;
  if (typeof model !== "string") throw new Error("model must be a string or null");
  const list = modelsFor(engine, env);
  if (isOpenRouterModel(model.trim()) && !supportsOpenRouter(engine)) throw new Error(`${engine} can't use OpenRouter (not supported); pick Claude Code, Codex or OpenCode`);
  if (!modelAllowed(engine, model.trim(), env)) throw new Error(`model '${model}' is not available for ${engine} (allowed: ${list.join(", ")}, or default)`);
  return model.trim();
}

/** CLI flags for the model; empty for the engine default. */
export function modelArgs(driver: AgentEngine, model: string | null | undefined): string[] {
  if (!model) return [];
  if (!SAFE.test(model)) throw new Error(`invalid model id '${model}'`);
  // OpenRouter on Claude Code / Codex: the CLI gets the OpenRouter slug; OpenCode takes openrouter/<vendor>/<model> natively.
  if (isOpenRouterModel(model) && driver !== "opencode") model = openRouterSlug(model);
  // codex exec -m <id>; opencode run -m <provider/model>; claude -p / cursor-agent -p --model <id>.
  return driver === "codex" || driver === "opencode" ? ["-m", model] : ["--model", model];
}
