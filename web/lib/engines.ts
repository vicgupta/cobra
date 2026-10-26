// The coding-agent engines Cobra can run, in one place (client-safe: no Node imports).
// MVP build: only claude-code (`claude -p`) and codex (`codex exec`). Rows that still name another
// engine (opencode, cursor, ...) stay in the DB but show as "not supported in this build" and can't run.
export const ENGINES = ["claude-code", "codex"] as const;
export type Engine = (typeof ENGINES)[number];
export const ENGINE_LABEL: Record<Engine, string> = { "claude-code": "Claude Code", codex: "Codex" };
export const isEngine = (v: unknown): v is Engine => typeof v === "string" && (ENGINES as readonly string[]).includes(v);
export const UNSUPPORTED_ENGINE = "engine not supported in this build";
export const engineLabel = (v: unknown): string => (isEngine(v) ? ENGINE_LABEL[v] : `${String(v ?? "")} (${UNSUPPORTED_ENGINE})`);
/** "claude-code or codex" */
export const ENGINE_LIST = `${ENGINES.slice(0, -1).join(", ")} or ${ENGINES[ENGINES.length - 1]}`;
