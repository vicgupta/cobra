import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { SessionsList } from "@/components/sessions-list";
import { getDb } from "@/lib/db";
import { listSessions } from "@/lib/auth/sessions";

export const metadata = { title: "Sessions · Cobra" };

export default function SessionsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
      <p className="mt-1 text-sm text-zinc-400">Devices and browsers signed in to your account.</p>
      <Suspense fallback={<p className="mt-6 text-sm text-zinc-500">Loading…</p>}>
        <AuthGate>{(u) => <SessionsList initial={listSessions(getDb(), u.id, u.sessionId)} />}</AuthGate>
      </Suspense>
    </div>
  );
}
