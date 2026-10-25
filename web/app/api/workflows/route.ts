import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, githubStore } from "@/lib/workflows/server";
import { listWorkflowsFor, saveWorkflow } from "@/lib/workflows/service";

export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = listWorkflowsFor(getDb(), actor(g.user));
  return NextResponse.json(r.body, { status: r.status });
}

/** Create or edit (previousName) a tenant workflow from YAML text; validated server-side. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = await saveWorkflow(getDb(), actor(g.user), await req.json().catch(() => null), { github: githubStore(g.user.tenantId) });
  return NextResponse.json(r.body, { status: r.status });
}
