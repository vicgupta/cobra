import type { AgentId, AuthMode } from "./types";

export type AgentFields = { subscription: string; apiKey: string };
export type Settings = Record<AgentId, AgentFields>;

export const AGENT_ENV: Record<AgentId, { subscription: string; subscriptionLabel: string; apiKey: string }> = {
  "claude-code": { subscription: "CLAUDE_CODE_OAUTH_TOKEN", subscriptionLabel: "Claude subscription (OAuth token)", apiKey: "ANTHROPIC_API_KEY" },
  codex: { subscription: "CODEX_AUTH_JSON", subscriptionLabel: "ChatGPT login (auth.json contents)", apiKey: "CODEX_API_KEY" },
};

export const emptySettings = (): Settings => ({
  "claude-code": { subscription: "", apiKey: "" },
  codex: { subscription: "", apiKey: "" },
});

/** Subscription wins if both are set, else API key, else not configured. */
export function resolveAuthMode(f: { subscription: boolean; apiKey: boolean }): AuthMode {
  if (f.subscription) return "subscription";
  if (f.apiKey) return "api-key";
  return "not-configured";
}

export function mask(value: string): string {
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

export type MaskedAgent = { subscription: string; apiKey: string; hasSubscription: boolean; hasApiKey: boolean; mode: AuthMode };
export type MaskedSettings = Record<AgentId, MaskedAgent> & { github: { token: string; hasToken: boolean } };
