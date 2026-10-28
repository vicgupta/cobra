"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { dangerBtn, ghostBtn, inputCls, primaryBtn, subtleDangerBtn } from "./styles";


const input = `${inputCls} font-mono placeholder:font-sans`;
const primary = primaryBtn;
const ghost = ghostBtn;
const subtleDanger = subtleDangerBtn;
const danger = dangerBtn;

type Msg = { ok: boolean; text: string } | null;
async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: r.ok, error: d.error ?? (r.ok ? undefined : `HTTP ${r.status}`) };
}
const Note = ({ msg }: { msg: Msg }) => msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>;

/** Two-step delete: the first click asks, the second deletes. */
function ConfirmDelete({ what, busy, onConfirm }: { what: string; busy: boolean; onConfirm: () => void }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button type="button" className={subtleDanger} disabled={busy} onClick={() => setAsk(true)}>Delete</button>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-confirm-delete>
      <span className="text-sm text-danger">Delete {what}?</span>
      <button type="button" className={danger} disabled={busy} onClick={() => { setAsk(false); onConfirm(); }} autoFocus>Yes, delete</button>
      <button type="button" className={ghost} disabled={busy} onClick={() => setAsk(false)}>Cancel</button>
    </span>
  );
}

/** Actions for one masked credential slot: add (or override env), inline Replace, Delete. The value is write-only.
 *  Team members only, own team (server-enforced). `open` = show the input straight away (the slot the auth method uses). */
export function CredentialForm({ engine, name, label, stored, open = false, multiline = false }: { engine: string; name: string; label: string; stored: boolean; open?: boolean; multiline?: boolean }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [expanded, setExpanded] = useState(open && !stored);
  const send = async (v: string | null) => {
    setBusy(true); setMsg(null);
    try {
      const r = await call(`/api/providers/${engine}/credentials`, "PUT", { name, value: v });
      setMsg(r.ok ? { ok: true, text: v ? (stored ? "Replaced" : "Saved") : "Deleted" } : { ok: false, text: r.error! });
      if (r.ok) { setValue(""); setExpanded(open && !stored && v === null); router.refresh(); }
    } finally { setBusy(false); }
  };
  if (!expanded) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-credential={name}>
        <button type="button" className={ghost} onClick={() => setExpanded(true)} aria-expanded={false} aria-controls={id}>{stored ? "Replace" : "Add"}</button>
        {stored && <ConfirmDelete what={label} busy={busy} onConfirm={() => void send(null)} />}
        <Note msg={msg} />
      </div>
    );
  }
  return (
    <form id={id} className="space-y-2" data-credential={name} data-expanded onSubmit={(e) => { e.preventDefault(); if (value.trim()) void send(value.trim()); }}>
      <label htmlFor={`${id}-v`} className="sr-only">{label}</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        {multiline ? (
          // Masked multi-line paste (auth.json); the value is never echoed back from the server.
          <textarea id={`${id}-v`} aria-label={`${engine} ${name}`} autoComplete="off" spellCheck={false} rows={4} className={`${input} min-h-[5.5rem] resize-y [-webkit-text-security:disc]`} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && (stored || !open)) { setValue(""); setExpanded(false); } }} placeholder={'Paste the contents of ~/.codex/auth.json'} autoFocus={stored || !open} data-masked />
        ) : <input id={`${id}-v`} aria-label={`${engine} ${name}`} type="password" autoComplete="off" spellCheck={false} className={input} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && (stored || !open)) { setValue(""); setExpanded(false); } }} placeholder={stored ? `New ${label}` : label} autoFocus={stored || !open} />}
        <div className="flex shrink-0 items-center gap-2">
          <button className={primary} disabled={busy || !value.trim()}>{stored ? "Replace" : "Save"}</button>
          {(stored || !open) && <button type="button" className={ghost} disabled={busy} onClick={() => { setValue(""); setExpanded(false); }}>Cancel</button>}
        </div>
      </div>
      <Note msg={msg} />
    </form>
  );
}

const MODE_LABEL: Record<string, string> = { auto: "Auto", api_key: "API key", subscription: "Subscription" };

/** Segmented auth-method control (native radios: arrow keys move, the change saves at once). */
export function AuthModeForm({ engine, modes, current, disabled = false }: { engine: string; modes: string[]; current: string; disabled?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState(current);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const pick = async (m: string) => {
    if (m === mode) return;
    const prev = mode; setMode(m); setBusy(true); setMsg(null);
    try { const r = await call(`/api/providers/${engine}/auth`, "PUT", { mode: m }); if (r.ok) router.refresh(); else { setMode(prev); setMsg({ ok: false, text: r.error! }); } } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col items-end gap-1" data-auth-mode={engine}>
      <fieldset role="radiogroup" aria-label={`${engine} auth method`} disabled={disabled || busy} className="inline-flex gap-1 rounded-lg bg-surface-2 p-1 text-sm">
        {modes.map((m) => (
          <label key={m} className={`inline-flex min-h-8 cursor-pointer items-center whitespace-nowrap rounded-md px-3 font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-emerald-500/60 ${mode === m ? "bg-bg text-fg shadow-sm ring-1 ring-border-strong" : "text-muted hover:text-fg"} ${disabled ? "cursor-default" : ""}`}>
            <input type="radio" className="sr-only" name={`auth-${engine}`} value={m} checked={mode === m} onChange={() => void pick(m)} />
            {MODE_LABEL[m] ?? m}
          </label>
        ))}
      </fieldset>
      <Note msg={msg} />
    </div>
  );
}
