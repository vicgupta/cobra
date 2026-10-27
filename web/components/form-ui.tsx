"use client";

// Shared form/list building blocks for Agents, Tasks and Skills (same look as Settings > Providers).
import { useEffect, useRef, type ReactNode } from "react";

export const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30 aria-[invalid=true]:border-red-500/70";
export const button = "inline-flex items-center justify-center rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
export const ghost = "inline-flex items-center justify-center rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
export const danger = "inline-flex items-center justify-center rounded-md px-2 py-1.5 text-sm text-danger hover:bg-danger-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
export const dangerSolid = "rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:opacity-50";
export const labelCls = "block text-sm font-medium text-fg-soft";
export const th = "px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-subtle";
export const td = "px-3 py-3 align-middle";

export async function call(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, data: (await r.json().catch(() => ({ error: `Something went wrong (HTTP ${r.status})` }))) as { error?: string; id?: string } };
}

/** Server messages start lowercase; show them as a sentence. */
export const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A labelled field with an optional hint and inline error. */
export function Field({ id, label, hint, error, children, optional }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode; optional?: boolean }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={labelCls}>{label}{optional && <span className="ml-1 font-normal text-subtle">(optional)</span>}</label>
      {children}
      {error ? <p id={`${id}-err`} className="text-xs text-danger" data-field-error>{error}</p> : hint ? <p id={`${id}-hint`} className="text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

/** A segmented choice (radio group with keyboard support from native radios). */
export function Segmented<T extends string>({ name, label, value, options, onChange }: { name: string; label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <fieldset>
      <legend className={`${labelCls} mb-1`}>{label}</legend>
      <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-border-strong bg-surface-2/60 p-0.5">
        {options.map(([v, text]) => (
          <label key={v} className={`cursor-pointer rounded-md px-3 py-1.5 text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${value === v ? "bg-bg font-medium text-fg shadow-sm ring-1 ring-border" : "text-muted hover:text-fg"}`}>
            <input type="radio" className="sr-only" name={name} value={v} checked={value === v} onChange={() => onChange(v)} aria-label={text} />{text}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** On/off switch (a button with role=switch). */
export function Switch({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${checked ? "bg-emerald-600" : "bg-slate-400/50"}`}>
      <span aria-hidden className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

/** A centered empty state with one primary action. */
export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center" data-empty-state>
      <p className="text-sm font-medium text-fg">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-md text-sm text-subtle">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A confirm dialog for destructive actions (Esc cancels; focus starts on Cancel). */
export function ConfirmDialog({ title, body, confirm, busy, onCancel, onConfirm }: { title: ReactNode; body: ReactNode; confirm: string; busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [busy, onCancel]);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && onCancel()}>
      <div className="w-full max-w-md rounded-xl border border-border bg-bg p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 id="confirm-title" className="text-base font-semibold text-fg">{title}</h3>
        <div className="mt-2 text-sm text-fg-soft">{body}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={ghost} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={dangerSolid} disabled={busy} onClick={onConfirm}>{busy ? "Deleting…" : confirm}</button>
        </div>
      </div>
    </div>
  );
}

/** "Lowercase letters, numbers and dashes" check shared by agent, task and skill names. */
export const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
export function nameProblem(name: string): string | null {
  if (!name) return null;
  if (!/^[a-z]/.test(name)) return "Start with a letter";
  if (!NAME_RE.test(name)) return name.length > 63 ? "Keep it to 63 characters or fewer" : "Use only lowercase letters, numbers and dashes";
  return null;
}
/** Lowercase as you type; spaces and underscores become dashes. */
export const slug = (v: string) => v.toLowerCase().replace(/[\s_]+/g, "-");
