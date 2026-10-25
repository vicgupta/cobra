import type { AgentId } from "./types";

export const RUN_STEPS = ["queued", "signing-in", "running", "pr-opened"] as const;
export type RunStep = (typeof RUN_STEPS)[number];
export const STEP_LABEL: Record<RunStep, string> = {
  queued: "Queued",
  "signing-in": "Signing in",
  running: "Running agent",
  "pr-opened": "PR opened",
};
/** Simulated ms offset at which each step starts. */
export const STEP_AT: Record<RunStep, number> = { queued: 0, "signing-in": 1500, running: 3500, "pr-opened": 8000 };

export type SimulatedRun = {
  id: string;
  agent: AgentId;
  repo: string;
  issue: number;
  title: string;
  prompt: string;
  startedAt: number;
  simulated: true;
};

export function stepAt(run: Pick<SimulatedRun, "startedAt">, now: number): RunStep {
  const elapsed = now - run.startedAt;
  let step: RunStep = "queued";
  for (const s of RUN_STEPS) if (elapsed >= STEP_AT[s]) step = s;
  return step;
}
