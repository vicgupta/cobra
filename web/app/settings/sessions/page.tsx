// Settings > Sessions (Job 7): moved from /account/sessions, which now redirects here. Every signed-in user sees
// only their own sessions; revoking goes through the unchanged /api/account/sessions routes.
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { SessionsList } from "@/components/sessions-list";
import { getDb } from "@/lib/db";
import { listSessions } from "@/lib/auth/sessions";

export const metadata = { title: "Sessions · Settings · Cobra" };

export default function SettingsSessionsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="mt-1 text-sm text-muted">Devices and browsers signed in to your account.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}>
        <AuthGate>{(u) => <SessionsList initial={listSessions(getDb(), u.id, u.sessionId)} />}</AuthGate>
      </Suspense>
    </div>
  );
}
