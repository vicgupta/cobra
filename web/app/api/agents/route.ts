import { customModelIds } from "@/lib/provider-credentials";
import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { AgentError, canEditAgent, createAgent, listAgents } from "@/lib/agents";
import { allModels } from "@/lib/agent-models";
import { actor, getDb } from "@/lib/workflows/server";

/** The team's agents (any team member; other teams never see them), plus the allowed models per engine. */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const u = actor(g.user);
  return NextResponse.json({ agents: listAgents(getDb(), u.tenantId).map((a) => ({ ...a, canEdit: canEditAgent(u, a) })), models: allModels(process.env, customModelIds(getDb())) });
}

/** Any team member may create agents. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try {
    return NextResponse.json(createAgent(getDb(), actor(g.user), await req.json().catch(() => null)), { status: 201 });
  } catch (e) {
    if (e instanceof AgentError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
