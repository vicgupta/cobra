export type AgentId = "claude-code" | "codex";
export type ReviewStatus = "awaiting-review" | "changes-requested" | "approved" | "merged" | "needs-attention";
export type RunStatus = "pending" | "running" | "pr-opened" | "needs-attention" | "failed";
export type AuthMode = "subscription" | "api-key" | "not-configured";

export const AGENT_LABEL: Record<AgentId, string> = { "claude-code": "Claude Code", codex: "Codex" };
