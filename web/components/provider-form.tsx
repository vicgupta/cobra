"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "rounded-md border border-border-strong bg-bg px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

/** System admins only; the server enforces the same rule (lib/providers.ts). */
export function ProviderDefaultsForm({ engine, models, tiers, current }: { engine: string; models: string[]; tiers: string[]; current: { model: string | null; effort: string | null } }) {
  const router = useRouter();
  const [model, setModel] = useState(current.model ?? "default");
  const [effort, setEffort] = useState(current.effort ?? "default");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/providers/${engine}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, effort }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      setMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: d.error ?? `HTTP ${r.status}` });
      if (r.ok) router.refresh();
    } finally { setBusy(false); }
  };
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="text-xs text-muted">Model <select aria-label={`${engine} default model`} className={input} value={model} onChange={(e) => setModel(e.target.value)}>
        <option value="default">CLI default</option>{models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select></label>
      <label className="text-xs text-muted">Effort <select aria-label={`${engine} default effort`} className={input} value={effort} onChange={(e) => setEffort(e.target.value)}>
        <option value="default">Default (no flag)</option>{tiers.map((t) => <option key={t} value={t}>{t}</option>)}
      </select></label>
      <button className={button} disabled={busy}>Save</button>
      {msg && <p role={msg.ok ? undefined : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </form>
  );
}
