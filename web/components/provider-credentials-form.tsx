"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "rounded-md border border-border-strong bg-bg px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const ghost = "rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2 disabled:opacity-50";
const danger = "rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";

type Msg = { ok: boolean; text: string } | null;
async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: r.ok, error: d.error ?? (r.ok ? undefined : `HTTP ${r.status}`) };
}
const Note = ({ msg }: { msg: Msg }) => msg && <p role={msg.ok ? undefined : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>;

/** Two-step delete: the first click asks, the second deletes. */
function ConfirmDelete({ what, busy, onConfirm }: { what: string; busy: boolean; onConfirm: () => void }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button type="button" className={ghost} disabled={busy} onClick={() => setAsk(true)}>Delete</button>;
  return (
    <span className="inline-flex items-center gap-2" data-confirm-delete>
      <span className="text-xs text-danger">Delete {what}?</span>
      <button type="button" className={danger} disabled={busy} onClick={() => { setAsk(false); onConfirm(); }}>Yes, delete</button>
      <button type="button" className={ghost} disabled={busy} onClick={() => setAsk(false)}>Cancel</button>
    </span>
  );
}

/** One masked credential slot: enter / replace / delete. The value is write-only. Team members only, own team (server-enforced). */
export function CredentialForm({ engine, name, label, stored }: { engine: string; name: string; label: string; stored: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const send = async (v: string | null) => {
    setBusy(true); setMsg(null);
    try {
      const r = await call(`/api/providers/${engine}/credentials`, "PUT", { name, value: v });
      setMsg(r.ok ? { ok: true, text: v ? (stored ? "Replaced" : "Saved") : "Deleted" } : { ok: false, text: r.error! });
      if (r.ok) { setValue(""); router.refresh(); }
    } finally { setBusy(false); }
  };
  return (
    <form className="flex flex-wrap items-center gap-2" data-credential={name} onSubmit={(e) => { e.preventDefault(); if (value.trim()) void send(value.trim()); }}>
      <input aria-label={`${engine} ${name}`} type="password" autoComplete="off" spellCheck={false} className={`${input} min-w-64`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={label} />
      <button className={button} disabled={busy || !value.trim()}>{stored ? "Replace" : "Save"}</button>
      {stored && <ConfirmDelete what={name} busy={busy} onConfirm={() => void send(null)} />}
      <Note msg={msg} />
    </form>
  );
}

const MODE_LABEL: Record<string, string> = { auto: "Auto (subscription first, else API key)", api_key: "API key", subscription: "Subscription" };

export function AuthModeForm({ engine, modes, current }: { engine: string; modes: string[]; current: string }) {
  const router = useRouter();
  const [mode, setMode] = useState(current);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <form className="flex flex-wrap items-center gap-2" data-auth-mode={engine} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setMsg(null);
      try { const r = await call(`/api/providers/${engine}/auth`, "PUT", { mode }); setMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error! }); if (r.ok) router.refresh(); } finally { setBusy(false); }
    }}>
      <label className="text-xs text-muted">Auth method <select aria-label={`${engine} auth method`} className={input} value={mode} onChange={(e) => setMode(e.target.value)}>
        {modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m] ?? m}</option>)}
      </select></label>
      <button className={button} disabled={busy || mode === current}>Save</button>
      <Note msg={msg} />
    </form>
  );
}
