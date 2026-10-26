// The coding-agent engines Cobra can run, in one place (client-safe: no Node imports).
// claude-code: `claude -p`, codex: `codex exec`, opencode: `opencode run`, cursor: Cursor CLI `cursor-agent -p`.
export const ENGINES = ["claude-code", "codex", "opencode", "cursor"] as const;
export type Engine = (typeof ENGINES)[number];
export const ENGINE_LABEL: Record<Engine, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", cursor: "Cursor" };
export const isEngine = (v: unknown): v is Engine => typeof v === "string" && (ENGINES as readonly string[]).includes(v);
export const engineLabel = (v: unknown): string => (isEngine(v) ? ENGINE_LABEL[v] : String(v ?? ""));
/** "claude-code, codex, opencode or cursor" */
export const ENGINE_LIST = `${ENGINES.slice(0, -1).join(", ")} or ${ENGINES[ENGINES.length - 1]}`;
