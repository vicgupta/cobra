import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { AgentsTabs } from "@/components/agents-tabs";
import { list } from "@/lib/skills/service";
import { loadTextSkills } from "@/lib/text-skills";
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
  // Skills an agent may run: the team's SOP skills (with approval status) and the text skills (by file name).
  const sop = ((list(db, u).body as { skills?: Array<{ id: number; name: string; status: string; tenantId: number }> }).skills ?? []).filter((s) => s.tenantId === u.tenantId);
  let text: SkillOption[] = [];
  try { text = loadTextSkills().map((t) => ({ ref: `text:${t.id}`, label: t.id, kind: "text", status: "no approval needed" })); } catch { text = []; }
  const skills: SkillOption[] = [...sop.map((s) => ({ ref: `sop:${s.id}`, label: s.name, kind: "sop" as const, status: s.status, href: `/agents/skills/${s.id}` })), ...text];
  return (
    <Card title="Team agents" subtitle="A named engine plus either a prompt or one skill, shared with your whole team. Run one now, or schedule it from Tasks.">
      <AgentManager agents={agents} repos={listTeamRepos(db, u.tenantId).map((r) => r.repo)} models={allModels(process.env)} skills={skills} />
    </Card>
  );
}

export default function AgentsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
      <AgentsTabs active="agents" />
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><AuthGate>{(u) => <Agents user={u} />}</AuthGate></Suspense>
    </div>
  );
}
