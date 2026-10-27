import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { AgentsTabs } from "@/components/agents-tabs";
import { list } from "@/lib/skills/service";
import type { SkillOption } from "@/components/agents";
import { AgentManager } from "@/components/agents";
import { canEditAgent, listAgents } from "@/lib/agents";
import { listTeamRepos } from "@/lib/repos";
import { allModels } from "@/lib/agent-models";
import { actor, getDb } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Agents · Cobra" };

function Agents({ user }: { user: SessionUser }) {
  const u = actor(user), db = getDb();
  const agents = listAgents(db, u.tenantId).map((a) => ({ ...a, canEdit: canEditAgent(u, a, db) }));
  // Skills an agent may run: the team's own skills.
  const sop = ((list(db, u).body as { skills?: Array<{ id: number; name: string; tenantId: number }> }).skills ?? []).filter((s) => s.tenantId === u.tenantId);
  const skills: SkillOption[] = [...sop.map((s) => ({ ref: `sop:${s.id}`, label: s.name, kind: "sop" as const, href: `/agents/skills/${s.id}` }))];
  return (
    <AgentManager agents={agents} repos={listTeamRepos(db, u.tenantId).map((r) => r.repo)} models={allModels(process.env)} skills={skills} />
  );
}

export default function AgentsPage() {
  return (
    <div className="space-y-6">
      <header><h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-sm text-muted">Coding agents your team can run. Schedule them from Tasks.</p></header>
      <AgentsTabs active="agents" />
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><AuthGate>{(u) => <Agents user={u} />}</AuthGate></Suspense>
    </div>
  );
}
