import { Suspense } from "react";
import { TestRun } from "@/components/test-run";
import { AuthGate } from "@/components/auth-gate";

export const metadata = { title: "Test run · Cobra" };

export default function NewRunPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Test run</h1>
        <p className="text-sm text-zinc-400">Simulated only — no agent is executed and nothing is pushed or opened on GitHub.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <AuthGate shared><TestRun /></AuthGate>
      </Suspense>
    </div>
  );
}
