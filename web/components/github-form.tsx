"use client";

import { useEffect, useState } from "react";

const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 font-mono text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";

/** GitHub token (GITHUB_TOKEN) saved to the server env file like the agent keys. */
export function GithubForm() {
  const [saved, setSaved] = useState<{ token: string; hasToken: boolean } | null>(null);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/settings").then((r) => (r.ok ? r.json() : null)).then((d) => d && setSaved(d.github));
  }, []);

  async function save(token: string) {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/admin/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ github: { token } }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      setSaved(d.github);
      setValue("");
      setMsg(token ? "Saved" : "Cleared");
    } else setMsg(d.error ?? "Could not save");
    setBusy(false);
  }

  return (
    <section className="rounded-xl border border-border bg-surface/40 p-5">
      <h2 className="text-lg font-semibold">GitHub</h2>
      <label className="mt-3 block space-y-1.5 text-sm">
        <span>
          GitHub token <code className="text-xs text-subtle">GITHUB_TOKEN</code>
          {saved && <span className="ml-2 text-xs text-muted">{saved.hasToken ? "Set" : "Not set"}</span>}
        </span>
        <input type="password" autoComplete="off" className={input} placeholder={saved?.hasToken ? "Enter a new token to replace" : "github_pat_…"} value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <p className="mt-1.5 text-xs text-muted">
        Fine-grained token limited to vicgupta/cobra-sandbox only. Permissions: Contents, Issues, and Pull requests — Read and write (Metadata read-only is added automatically).{" "}
        <a className="text-accent underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a token</a>
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button disabled={busy || !value.trim()} onClick={() => save(value)} className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">Save</button>
        {saved?.hasToken && <button disabled={busy} onClick={() => save("")} className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50">Clear</button>}
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </section>
  );
}
