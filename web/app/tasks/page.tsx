import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { TaskManager, type TaskSkillOption } from "@/components/tasks";
import { list } from "@/lib/skills/service";
import { loadTextSkills } from "@/lib/text-skills";
import { listAgents } from "@/lib/agents";
import { canEditTask, listTasks } from "@/lib/tasks";
import { listTeamRepos } from "@/lib/repos";
import { actor, getDb } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Tasks · Cobra" };

function Tasks({ user }: { user: SessionUser }) {
  const u = actor(user), db = getDb();
  const tasks = listTasks(db, u.tenantId).map((t) => ({ ...t, canEdit: canEditTask(u, t, db) }));
  const sop = ((list(db, u).body as { skills?: Array<{ id: number; name: string; status: string; tenantId: number }> }).skills ?? []).filter((s) => s.tenantId === u.tenantId);
  let text: TaskSkillOption[] = [];
  try { text = loadTextSkills().map((t) => ({ ref: `text:${t.id}`, name: t.id, status: "" })); } catch { text = []; }
  const skills: TaskSkillOption[] = [...sop.map((s) => ({ ref: `sop:${s.id}`, name: s.name, status: s.status })), ...text];
  return (
    <Card title="Team tasks" subtitle="Run an agent (optionally with one skill) on a schedule, America/New_York. Tasks start disabled; Run now is always available.">
      <TaskManager tasks={tasks} agents={listAgents(db, u.tenantId).map((a) => a.name)} skills={skills} repos={listTeamRepos(db, u.tenantId).map((r) => r.repo)} />
    </Card>
  );
}

export default function TasksPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><AuthGate>{(u) => <Tasks user={u} />}</AuthGate></Suspense>
    </div>
  );
}
