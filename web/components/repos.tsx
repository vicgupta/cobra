import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { ListSkeleton } from "@/components/collab-view";
import { RepoManager } from "@/components/workflows";
import { canAddRepo, canEditRepo, canManageRepos, globalCeiling, listTeamRepos } from "@/lib/repos";
import { actor, getDb } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";

function Repos({ user }: { user: SessionUser }) {
  const ceiling = globalCeiling();
  const db = getDb(), u = actor(user);
  const rows = listTeamRepos(db, u.tenantId).map((r) => ({ ...r, canEdit: canEditRepo(db, u, r) }));
  return (
    <Card title="Team GitHub repos" subtitle={`Workflows, GitHub file storage and agent runs can only use these repos${ceiling ? " (and the server's COBRA_GITHUB_ALLOWED_REPOS ceiling, except repos added with their own token)" : ""}.`}>
      <RepoManager initial={rows} canManage={canManageRepos(user)} canAdd={canAddRepo(user)} />
    </Card>
  );
}

/** Team repos. Moved unchanged from app/repos/page.tsx in Job 17; shown at /settings/repos. */
export function ReposView() {
  return (
    <div className="space-y-6">
      <PageHeader title="Repos" />
      <Suspense fallback={<ListSkeleton />}><AuthGate>{(u) => <Repos user={u} />}</AuthGate></Suspense>
    </div>
  );
}
