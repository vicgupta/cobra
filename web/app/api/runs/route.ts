import { NextResponse } from "next/server";
import { stepAt } from "@/lib/runs";
import { listRuns } from "@/lib/runs-db";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, runDeps } from "@/lib/workflows/server";
import { startRun } from "@/lib/workflows/service";
import { isEngine } from "@/lib/engines";

// Test runs are the built-in workflows/test-run.yaml, executed by the workflow
// engine (simulated steps only: nothing executes Claude Code or Codex).
const TEST_RUN_WORKFLOW = "test-run";

// Any member of the tenant may list and start test runs (approval of test-run is still required).
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const now = Date.now();
  return NextResponse.json(listRuns(g.user.tenantId).filter((r) => !r.workflow || r.workflow === TEST_RUN_WORKFLOW).map((r) => ({ ...r, step: stepAt(r, now) })));
}

export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const inputs = { agent: b.agent, repo: b.repo, issue: b.issue, title: b.title, prompt: b.prompt };
  const r = startRun(getDb(), actor(g.user), TEST_RUN_WORKFLOW, { inputs, mode: "simulated", engine: isEngine(b.agent) ? b.agent : "claude-code", ...(typeof b.prompt === "string" && b.prompt.trim() ? { promptMode: "custom", prompt: b.prompt } : { promptMode: "none" }) }, runDeps(g.user.tenantId, actor(g.user)), { idPrefix: "sim_" });
  if (!r.run) return NextResponse.json(r.body, { status: r.status });
  const i = r.run.inputs;
  return NextResponse.json({
    id: r.run.id, agent: i.agent, repo: i.repo, issue: i.issue, title: String(i.title || "") || `Issue #${i.issue}`, prompt: i.prompt ?? "",
    startedAt: r.run.startedAt, simulated: true, workflow: TEST_RUN_WORKFLOW, step: "queued",
  }, { status: 201 });
}
