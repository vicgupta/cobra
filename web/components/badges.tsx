import { Badge, type Tone } from "./ui";
import { AGENT_LABEL, type AgentId, type AuthMode, type ReviewStatus, type RunStatus } from "@/lib/types";

export function AgentBadge({ agent }: { agent: AgentId }) {
  return <Badge tone={agent === "claude-code" ? "orange" : "violet"}>{AGENT_LABEL[agent]}</Badge>;
}

const review: Record<ReviewStatus, [Tone, string]> = {
  "awaiting-review": ["blue", "Awaiting review"],
  "changes-requested": ["amber", "Changes requested"],
  approved: ["green", "Approved"],
  merged: ["violet", "Merged"],
  "needs-attention": ["red", "Needs attention"],
};
export function ReviewBadge({ status }: { status: ReviewStatus }) {
  const [tone, label] = review[status];
  return <Badge tone={tone} dot>{label}</Badge>;
}

const run: Record<RunStatus, [Tone, string]> = {
  pending: ["gray", "Pending"],
  running: ["blue", "Running"],
  "pr-opened": ["green", "PR opened"],
  "needs-attention": ["amber", "Needs attention"],
  failed: ["red", "Failed"],
};
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const [tone, label] = run[status];
  return <Badge tone={tone} dot>{label}</Badge>;
}

export function AuthBadge({ mode }: { mode: AuthMode }) {
  if (mode === "subscription") return <Badge tone="green">Subscription</Badge>;
  if (mode === "api-key") return <Badge tone="blue">API key</Badge>;
  return <Badge tone="gray">Not configured</Badge>;
}
