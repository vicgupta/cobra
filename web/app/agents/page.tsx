import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { AgentManager } from "@/components/agents";
import { canEditAgent, listAgents } from "@/lib/agents";
import { listTeamRepos } from "@/lib/repos";
import { actor, getDb } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Agents · Cobra" };

function Agents({ user }: { user: SessionUser }) {
  const u = actor(user), db = getDb();
  const agents = listAgents(db, u.tenantId).map((a) => ({ ...a, canEdit: canEditAgent(u, a) }));
  return (
    <Card title="Team agents" subtitle="A named engine + prompt, shared with your whole team. Run one directly, or use it in a workflow step with `uses: agent` and `with: { agent: <name> }`.">
      <AgentManager agents={agents} repos={listTeamRepos(db, u.tenantId).map((r) => r.repo)} />
    </Card>
  );
}

export default function AgentsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><AuthGate>{(u) => <Agents user={u} />}</AuthGate></Suspense>
    </div>
  );
}
