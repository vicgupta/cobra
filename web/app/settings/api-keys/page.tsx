import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { ListSkeleton } from "@/components/collab-view";
import { ApiKeysManager } from "@/components/api-keys";
import { canManageKeys, listKeys } from "@/lib/team-api/keys";
import { actor, getDb } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "API keys · Settings · Cobra" };

function Keys({ user }: { user: SessionUser }) {
  const db = getDb(), u = actor(user);
  const repos = (db.prepare("SELECT id, repo FROM team_repos WHERE tenant_id = ? ORDER BY repo").all(u.tenantId) as Array<{ id: number; repo: string }>).map((r) => ({ id: r.id, repo: r.repo }));
  return (
    <Card title="Team API keys" subtitle={`Each key works for one repo of this team only (team ${u.tenantId}). Calls go to /api/v1/teams/${u.tenantId}/repos/<repo id>/… with Authorization: Bearer <key>. Only team leads and the designated lead can create or revoke keys.`}>
      <ApiKeysManager initial={listKeys(db, u.tenantId)} repos={repos} teamId={u.tenantId} canManage={canManageKeys(db, u)} />
    </Card>
  );
}

export default function SettingsApiKeysPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="API keys" />
      <Suspense fallback={<ListSkeleton />}><AuthGate>{(u) => <Keys user={u} />}</AuthGate></Suspense>
    </div>
  );
}
