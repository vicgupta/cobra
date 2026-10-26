import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { RepoManager } from "@/components/workflows";
import { canAddRepo, canEditRepo, canManageRepos, globalCeiling, listRepoAudit, listTeamRepos } from "@/lib/repos";
import { actor, getDb } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";

function Repos({ user }: { user: SessionUser }) {
  const ceiling = globalCeiling();
  const db = getDb(), u = actor(user);
  const rows = listTeamRepos(db, u.tenantId).map((r) => ({ ...r, canEdit: canEditRepo(db, u, r) }));
  const audit = listRepoAudit(db, u.tenantId);
  return (
    <>
    <Card title="Team GitHub repos" subtitle={`Workflows, GitHub file storage and agent runs can only use these repos${ceiling ? " (and the server's COBRA_GITHUB_ALLOWED_REPOS ceiling)" : ""}.`}>
      <RepoManager initial={rows} canManage={canManageRepos(user)} canAdd={canAddRepo(user)} />
    </Card>
    <Card title="Recent repo changes" subtitle="Adds, edits, removals and token changes in your team.">
      {audit.length === 0 ? <p className="text-sm text-subtle">No changes yet.</p> : (
        <ul className="space-y-1 text-sm">{audit.map((a, i) => (
          <li key={i} className="text-fg-soft"><span className="text-subtle">{new Date(a.at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} ET</span> · {a.actorEmail} · {a.action.replace("_", " ")} <span className="font-mono">{a.repo}</span>{a.detail ? ` (${a.detail})` : ""}</li>
        ))}</ul>
      )}
    </Card>
    </>
  );
}

/** Team repos. Moved unchanged from app/repos/page.tsx in Job 17; shown at /settings/repos. */
export function ReposView() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><AuthGate>{(u) => <Repos user={u} />}</AuthGate></Suspense>
    </div>
  );
}
