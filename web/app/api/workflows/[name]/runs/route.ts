import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, runDeps } from "@/lib/workflows/server";
import { startRun } from "@/lib/workflows/service";
import { parseHistoryFilter, parsePage, workflowRunHistory } from "@/lib/workflows/run-history";

/** Run history (read-only audit trail), newest first: ?status=all|passed|failed|running&page=N (25 per page).
 *  Members/leads: their team's runs; system admins: all teams (with team). Another team's workflow: 404. */
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const q = new URL(req.url).searchParams;
  const r = workflowRunHistory(getDb(), actor(g.user), (await ctx.params).name, { filter: parseHistoryFilter(q.get("status")), page: parsePage(q.get("page")), secrets: runDeps(g.user.tenantId).redact() });
  return NextResponse.json(r.body, { status: r.status });
}

/** Starts a run (409 unless this exact version is approved); executes in the background. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = startRun(getDb(), actor(g.user), (await ctx.params).name, await req.json().catch(() => null), runDeps(g.user.tenantId, actor(g.user)));
  return NextResponse.json(r.body, { status: r.status });
}
