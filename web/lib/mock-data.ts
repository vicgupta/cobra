// EXAMPLE DATA ONLY — shown in the dashboard until Cobra is wired to real runs.
import type { AgentId, AuthMode, ReviewStatus, RunStatus } from "./types";

export type TeamMember = {
  name: string;
  role: "Approver" | "Reviewer" | "Admin";
  status: "online" | "reviewing" | "away";
  openReviews: number;
};

export type FactoryRun = {
  id: string;
  issue: number;
  title: string;
  summary: string;
  repo: string;
  agent: AgentId;
  runStatus: RunStatus;
  review: ReviewStatus;
  pr: number | null;
  durationMin: number;
  when: string;
};

export type AgentActivity = {
  agent: AgentId;
  activeJobs: number;
  successRate: number;
  lastRun: string;
  authMode: AuthMode;
  runsThisWeek: number;
};

export const team: TeamMember[] = [
  { name: "Vic Gupta", role: "Admin", status: "online", openReviews: 1 },
  { name: "Maya Chen", role: "Approver", status: "reviewing", openReviews: 3 },
  { name: "Diego Alvarez", role: "Reviewer", status: "online", openReviews: 2 },
  { name: "Priya Nair", role: "Reviewer", status: "away", openReviews: 0 },
  { name: "Sam Okafor", role: "Approver", status: "online", openReviews: 1 },
];

export const runs: FactoryRun[] = [
  { id: "run_1042", issue: 214, title: "Add rate limiting to public API", summary: "Token-bucket middleware on /v1/* with per-key limits and 429 responses; tests added.", repo: "acme/api", agent: "claude-code", runStatus: "pr-opened", review: "awaiting-review", pr: 388, durationMin: 14, when: "12 min ago" },
  { id: "run_1041", issue: 97, title: "Dark mode toggle in settings", summary: "Theme context + persisted preference; updated 6 components to use CSS variables.", repo: "acme/web", agent: "codex", runStatus: "pr-opened", review: "changes-requested", pr: 512, durationMin: 9, when: "48 min ago" },
  { id: "run_1040", issue: 211, title: "Fix flaky checkout integration test", summary: "Replaced sleep-based waits with explicit polling; seeded clock for deterministic totals.", repo: "acme/api", agent: "claude-code", runStatus: "pr-opened", review: "approved", pr: 386, durationMin: 6, when: "2 h ago" },
  { id: "run_1039", issue: 45, title: "CSV export for invoices", summary: "Streaming CSV endpoint plus Export button on the invoices table.", repo: "acme/billing", agent: "codex", runStatus: "pr-opened", review: "merged", pr: 77, durationMin: 18, when: "5 h ago" },
  { id: "run_1038", issue: 102, title: "Upgrade to Node 22 in CI", summary: "Bumped CI matrix; one native dependency fails to build — needs a human decision.", repo: "acme/web", agent: "claude-code", runStatus: "needs-attention", review: "needs-attention", pr: 509, durationMin: 22, when: "yesterday" },
  { id: "run_1037", issue: 39, title: "Retry webhook deliveries with backoff", summary: "Exponential backoff with jitter, dead-letter after 8 attempts, admin replay action.", repo: "acme/billing", agent: "codex", runStatus: "pr-opened", review: "merged", pr: 74, durationMin: 16, when: "yesterday" },
  { id: "run_1036", issue: 208, title: "Paginate /v1/projects", summary: "Cursor pagination with backwards-compatible defaults and updated OpenAPI spec.", repo: "acme/api", agent: "claude-code", runStatus: "pr-opened", review: "awaiting-review", pr: 383, durationMin: 11, when: "2 days ago" },
];

export const agents: AgentActivity[] = [
  { agent: "claude-code", activeJobs: 2, successRate: 0.92, lastRun: "12 min ago", authMode: "subscription", runsThisWeek: 23 },
  { agent: "codex", activeJobs: 1, successRate: 0.88, lastRun: "48 min ago", authMode: "api-key", runsThisWeek: 17 },
];

export const weekStats = { runsThisWeek: 40, prsOpened: 34, awaitingReview: runs.filter((r) => r.review === "awaiting-review").length };
