import { NextResponse } from "next/server";
import { stepAt, type SimulatedRun } from "@/lib/runs";
import { readJson, writeJson } from "@/lib/store";

// Simulated runs only: nothing here executes Claude Code or Codex.
const FILE = "runs.json";

export async function GET() {
  const runs = await readJson<SimulatedRun[]>(FILE, []);
  const now = Date.now();
  return NextResponse.json(runs.map((r) => ({ ...r, step: stepAt(r, now) })));
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as Partial<SimulatedRun> | null;
  if (!b) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const issue = Number(b.issue);
  if (b.agent !== "claude-code" && b.agent !== "codex") return NextResponse.json({ error: "agent must be claude-code or codex" }, { status: 400 });
  if (!b.repo || !/^[\w.-]+\/[\w.-]+$/.test(b.repo)) return NextResponse.json({ error: "repo must look like owner/name" }, { status: 400 });
  if (!Number.isInteger(issue) || issue <= 0) return NextResponse.json({ error: "issue must be a positive integer" }, { status: 400 });

  const run: SimulatedRun = {
    id: `sim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    agent: b.agent,
    repo: b.repo,
    issue,
    title: String(b.title ?? "").slice(0, 200) || `Issue #${issue}`,
    prompt: String(b.prompt ?? "").slice(0, 4000),
    startedAt: Date.now(),
    simulated: true,
  };
  const runs = await readJson<SimulatedRun[]>(FILE, []);
  await writeJson(FILE, [run, ...runs].slice(0, 50));
  return NextResponse.json({ ...run, step: "queued" }, { status: 201 });
}
