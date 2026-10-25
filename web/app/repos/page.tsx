import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { RepoManager } from "@/components/workflows";
import { canManageRepos, globalCeiling, listTeamRepos } from "@/lib/repos";
import { getDb } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Repos · Cobra" };

function Repos({ user }: { user: SessionUser }) {
  const ceiling = globalCeiling();
  return (
    <Card title="Team GitHub repos" subtitle={`Workflows, GitHub file storage and agent runs can only use these repos${ceiling ? " (and the server's COBRA_GITHUB_ALLOWED_REPOS ceiling)" : ""}.`}>
      <RepoManager initial={listTeamRepos(getDb(), user.tenantId)} canManage={canManageRepos(user)} />
    </Card>
  );
}

export default function ReposPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><AuthGate>{(u) => <Repos user={u} />}</AuthGate></Suspense>
    </div>
  );
}
