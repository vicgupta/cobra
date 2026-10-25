import { SettingsForm } from "@/components/settings-form";

export const metadata = { title: "Settings · Cobra" };

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent credentials</h1>
        <p className="text-sm text-zinc-400">A subscription token wins when both are set; otherwise the API key is used.</p>
      </div>
      <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-4 py-2 text-xs text-amber-200">
        Local dev storage only: values are saved in plain text to <code>web/data/settings.json</code> (gitignored). Saved secrets are never sent back to the browser — only the last 4 characters.
      </div>
      <SettingsForm />
    </div>
  );
}
