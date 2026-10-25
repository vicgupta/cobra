import type { AgentId, AuthMode } from "./types";

export type AgentFields = { subscription: string; apiKey: string };
export type Settings = Record<AgentId, AgentFields>;

export const AGENT_ENV: Record<AgentId, { subscription: string; subscriptionLabel: string; subscriptionHelp: string; apiKey: string }> = {
  "claude-code": { subscription: "CLAUDE_CODE_OAUTH_TOKEN", subscriptionLabel: "Claude Code OAuth token (from `claude setup-token`)", subscriptionHelp: "Run `claude setup-token` on a machine signed in to your Claude subscription and paste the token here. Stored in the server env file; never shown again.", apiKey: "ANTHROPIC_API_KEY" },
  codex: { subscription: "CODEX_AUTH_JSON", subscriptionLabel: "ChatGPT login (auth.json contents)", subscriptionHelp: "", apiKey: "CODEX_API_KEY" },
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
  // Status only: never echo any part of a secret back to the browser.
  return value ? "Set" : "";
}

export type MaskedAgent = { subscription: string; apiKey: string; hasSubscription: boolean; hasApiKey: boolean; mode: AuthMode };
export type MaskedSettings = Record<AgentId, MaskedAgent> & { github: { token: string; hasToken: boolean } };
