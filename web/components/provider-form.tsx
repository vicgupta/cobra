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
      const r = await fetch(`/api/providers/${engine}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(tiers.length ? { model, effort } : { model }) });
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
        {tiers.length ? <><option value="default">Default (no flag)</option>{tiers.map((t) => <option key={t} value={t}>{t}</option>)}</> : <option value="default">Not supported</option>}
      </select></label>
      <button className={button} disabled={busy}>Save</button>
      {msg && <p role={msg.ok ? undefined : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </form>
  );
}

/** Masked provider secret (Cursor API key). Write-only: the server never sends the value back. System admins only. */
export function ProviderSecretForm({ engine, label, name, help, set }: { engine: string; label: string; name: string; help: string; set: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async (v: string | null) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/providers/${engine}/secret`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: v }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      setMsg(r.ok ? { ok: true, text: v ? "Saved" : "Cleared" } : { ok: false, text: d.error ?? `HTTP ${r.status}` });
      if (r.ok) { setValue(""); router.refresh(); }
    } finally { setBusy(false); }
  };
  return (
    <form className="flex flex-wrap items-center gap-2" data-provider-secret={name} onSubmit={(e) => { e.preventDefault(); if (value.trim()) void send(value.trim()); }}>
      <label className="text-xs text-muted">{label} <span className="font-mono">({name})</span>{" "}
        <input aria-label={`${engine} ${name}`} type="password" autoComplete="off" spellCheck={false} className={input} value={value} onChange={(e) => setValue(e.target.value)} placeholder={set ? "•••••••• (set; type to replace)" : "Not set"} />
      </label>
      <button className={button} disabled={busy || !value.trim()}>Save</button>
      {set && <button type="button" className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2" disabled={busy} onClick={() => void send(null)}>Clear</button>}
      <p className="w-full text-xs text-subtle">{help} Stored encrypted; never shown again.</p>
      {msg && <p role={msg.ok ? undefined : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </form>
  );
}
