import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { TaskManager, type TaskSkillOption } from "@/components/tasks";
import { AutomationLibrary } from "@/components/automation-library";
import { LIBRARY_PACKS } from "@/lib/automation-library";
import { list } from "@/lib/skills/service";
import { listAgents } from "@/lib/agents";
import { canEditTask, listTasks } from "@/lib/tasks";
import { listTeamRepos } from "@/lib/repos";
import { displayTeamMembers } from "@/lib/team";
import { teamHasMailbox } from "@/lib/team-email";
import { actor, getDb } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";

/** Request time, for "2 hours ago" labels (server render). */
const requestTime = () => Date.now();

export const metadata = { title: "Tasks · Cobra" };

function Tasks({ user }: { user: SessionUser }) {
  const u = actor(user), db = getDb();
  const tasks = listTasks(db, u.tenantId).map((t) => ({ ...t, canEdit: canEditTask(u, t, db) }));
  const sop = ((list(db, u).body as { skills?: Array<{ id: number; name: string; tenantId: number }> }).skills ?? []).filter((s) => s.tenantId === u.tenantId);
  const skills: TaskSkillOption[] = [...sop.map((s) => ({ ref: `sop:${s.id}`, name: s.name }))];
  const agents = listAgents(db, u.tenantId).map((a) => ({ name: a.name, skillRef: a.skillRef ?? null }));
  const repos = listTeamRepos(db, u.tenantId).map((r) => r.repo);
  const members = displayTeamMembers(db, u.tenantId).map((m) => ({ email: m.email, name: m.name }));
  const hasTeamEmail = teamHasMailbox(db, u.tenantId);
  return (
    <div className="space-y-8">
      <AutomationLibrary packs={LIBRARY_PACKS} agents={agents} repos={repos} members={members} hasTeamEmail={hasTeamEmail} />
      <TaskManager tasks={tasks} agents={agents} skills={skills} repos={repos} now={requestTime()} members={members} hasTeamEmail={hasTeamEmail} />
    </div>
  );
}

export default function TasksPage() {
  return (
    <div className="space-y-6">
      <header><h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="mt-1 text-sm text-muted">Run an agent on a schedule or on demand. Times are Eastern (ET).</p></header>
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><AuthGate>{(u) => <Tasks user={u} />}</AuthGate></Suspense>
    </div>
  );
}
