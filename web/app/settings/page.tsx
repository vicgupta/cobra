import { SettingsForm } from "@/components/settings-form";
import { Suspense } from "react";
import { EnvFilePath } from "@/components/live-config";


export const metadata = { title: "Settings · Cobra" };

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent credentials</h1>
        <p className="text-sm text-zinc-400">A subscription token wins when both are set; otherwise the API key is used.</p>
      </div>
      <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-4 py-2 text-xs text-amber-200">
        Values are saved to the server environment file <Suspense fallback={<code>…</code>}><EnvFilePath /></Suspense> and used by the agent driver on the next run (no restart needed). Saved secrets are never sent back to the browser — only the last 4 characters.
      </div>
      <SettingsForm />
    </div>
  );
}
