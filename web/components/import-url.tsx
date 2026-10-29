"use client";
// "Import from URL" box (Repos-style tokens from styles.ts), shared by the new-skill and new-agent forms.
// The server fetches and parses the file; this only shows the result and hands the fields to the form.
import { useState } from "react";
import { errText, fieldLabel, ghostBtn, inputCls, primaryBtn, sectionTitle } from "./styles";

export type ImportResponse = { ok: boolean; sourceUrl?: string; file?: string; warnings: string[]; errors: Record<string, string | undefined> } & Record<string, unknown>;

export function ImportFromUrl({ endpoint, what, examples, onImported }: { endpoint: string; what: string; examples: string; onImported: (r: ImportResponse) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const go = async () => {
    setBusy(true); setErr(null);
    const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as ImportResponse | null;
    setBusy(false);
    if (!r || !j) return setErr("Couldn't reach the server");
    if (j.errors?.url) return setErr(j.errors.url);
    if (!r.ok) return setErr(`Import failed (HTTP ${r.status})`);
    onImported(j);
  };
  return (
    <section className="rounded-xl border border-border bg-surface/60 p-4 shadow-sm" data-testid="import-url" aria-labelledby="import-url-h">
      <div className="flex items-center justify-between gap-2">
        <h3 id="import-url-h" className={sectionTitle}>Import from URL</h3>
        <button type="button" className={ghostBtn} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void go(); }}>
        <label htmlFor="import-url-input" className={fieldLabel}>{what} URL</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input id="import-url-input" name="url" className={inputCls} placeholder="https://github.com/owner/repo/tree/main/skills/my-skill" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!!err} />
          <button className={primaryBtn} disabled={busy || !url.trim()}>{busy ? "Importing…" : "Import"}</button>
        </div>
        <p className="text-xs text-subtle">{examples} Nothing is saved until you review the form below and create it.</p>
        {err && <p role="alert" className={errText} data-testid="import-error">{err}</p>}
      </form>}
    </section>
  );
}

/** Warnings and the source line shown above a pre-filled form. */
export function ImportNotice({ sourceUrl, warnings, errors }: { sourceUrl: string; warnings: string[]; errors: Record<string, string | undefined> }) {
  const errs = Object.entries(errors).filter(([, v]) => v) as Array<[string, string]>;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2/40 p-3 text-sm" data-testid="import-notice">
      <p className="text-fg-soft">Imported from <a className="break-all underline" href={sourceUrl} target="_blank" rel="noreferrer noopener">{sourceUrl}</a>. Review and edit, then create.</p>
      {warnings.map((w, i) => <p key={i} className="text-amber-600 dark:text-amber-400" data-testid="import-warning">⚠ {w}</p>)}
      {errs.length > 0 && <ul className="list-disc pl-5 text-danger" data-testid="import-field-errors">{errs.map(([k, v]) => <li key={k}><b className="capitalize">{k}</b>: {v}</li>)}</ul>}
    </div>
  );
}
