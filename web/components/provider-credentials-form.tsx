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
export function CredentialForm({ engine, name, label, help, set, stored }: { engine: string; name: string; label: string; help: string; set: boolean; stored: boolean }) {
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
      <input aria-label={`${engine} ${name}`} type="password" autoComplete="off" spellCheck={false} className={`${input} min-w-64`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={stored ? "Type a new value to replace" : set ? "Set in server env; type to override" : `Paste ${label}`} />
      <button className={button} disabled={busy || !value.trim()}>{stored ? "Replace" : "Save"}</button>
      {stored && <ConfirmDelete what={name} busy={busy} onConfirm={() => void send(null)} />}
      <p className="w-full text-xs text-subtle">{help} Stored encrypted; never shown again.</p>
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

type CP = { id: string; name: string; baseUrl: string; models: string[] };

/** Add (no initial) or edit (initial) a custom OpenAI-compatible provider; edit also offers delete. */
export function CustomProviderForm({ initial, keyStored }: { initial?: CP; keyStored?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ id: initial?.id ?? "", name: initial?.name ?? "", baseUrl: initial?.baseUrl ?? "", models: initial?.models.join(", ") ?? "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error! }); if (r.ok) { setF((x) => ({ ...x, apiKey: "" })); if (!initial) setF({ id: "", name: "", baseUrl: "", models: "", apiKey: "" }); setOpen(false); router.refresh(); } } finally { setBusy(false); }
  };
  if (!open) return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={initial ? ghost : button} onClick={() => setOpen(true)} data-open-custom={initial?.id ?? "new"}>{initial ? "Edit" : "Add provider"}</button>
      {initial && <ConfirmDelete what={`${initial.name} and its API key`} busy={busy} onConfirm={() => void run(() => call(`/api/custom-providers/${initial.id}`, "DELETE"), "Deleted")} />}
      <Note msg={msg} />
    </div>
  );
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const body = { name: f.name, baseUrl: f.baseUrl, models: f.models, ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}) };
  return (
    <form className="grid gap-2 sm:grid-cols-2" data-custom-form={initial?.id ?? "new"} onSubmit={(e) => { e.preventDefault(); void (initial ? run(() => call(`/api/custom-providers/${initial.id}`, "PUT", body), "Saved") : run(() => call("/api/custom-providers", "POST", { id: f.id, ...body }), "Added")); }}>
      <label className="text-xs text-muted">ID (used in model ids: &lt;id&gt;/&lt;model&gt;)<input className={`${input} w-full`} value={f.id} onChange={set("id")} disabled={!!initial} placeholder="e.g. together" aria-label="custom provider id" /></label>
      <label className="text-xs text-muted">Display name<input className={`${input} w-full`} value={f.name} onChange={set("name")} placeholder="e.g. Together AI" aria-label="custom provider name" /></label>
      <label className="text-xs text-muted sm:col-span-2">Base URL (OpenAI-compatible)<input className={`${input} w-full font-mono`} value={f.baseUrl} onChange={set("baseUrl")} placeholder="https://api.together.xyz/v1" aria-label="custom provider base URL" /></label>
      <label className="text-xs text-muted sm:col-span-2">Models (comma or space separated)<input className={`${input} w-full font-mono`} value={f.models} onChange={set("models")} placeholder="meta-llama/Llama-3.3-70B-Instruct-Turbo" aria-label="custom provider models" /></label>
      <label className="text-xs text-muted sm:col-span-2">API key {initial ? (keyStored ? "(stored; type to replace)" : "(not set)") : "(optional)"}<input type="password" autoComplete="off" spellCheck={false} className={`${input} w-full`} value={f.apiKey} onChange={set("apiKey")} aria-label="custom provider API key" /></label>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button className={button} disabled={busy}>{initial ? "Save" : "Add provider"}</button>
        <button type="button" className={ghost} onClick={() => setOpen(false)}>Cancel</button>
        {initial && keyStored && <ConfirmDelete what="the API key" busy={busy} onConfirm={() => void run(() => call(`/api/custom-providers/${initial.id}`, "PUT", { apiKey: null }), "API key deleted")} />}
        <Note msg={msg} />
      </div>
    </form>
  );
}
