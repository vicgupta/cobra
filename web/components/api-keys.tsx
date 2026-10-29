"use client";
import { useState } from "react";
import type { ApiKey } from "@/lib/team-api/keys";
import { errText, fieldLabel, ghostBtn, inputCls, primaryBtn, selectCls, subtleDangerBtn, tableCls, tableWrap, td, th, theadCls } from "./styles";

const when = (t: number | null) => (t ? new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "never");

export function ApiKeysManager({ initial, repos, teamId, canManage }: { initial: ApiKey[]; repos: Array<{ id: number; repo: string }>; teamId: number; canManage: boolean }) {
  const [keys, setKeys] = useState(initial);
  const [name, setName] = useState(""), [repoId, setRepoId] = useState(repos[0]?.id ?? 0);
  const [fresh, setFresh] = useState<{ plaintext: string; key: ApiKey } | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await fetch("/api/team/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, repoId }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setError(j.error ?? "could not create the key");
    setFresh(j); setName(""); setKeys([j.key, ...keys]);
  };
  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke ${k.name} (${k.prefix}…)? Calls with it will get 401.`)) return;
    const r = await fetch(`/api/team/api-keys/${k.id}/revoke`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setError(j.error ?? "could not revoke");
    setKeys(keys.map((x) => (x.id === k.id ? j.key : x)));
  };
  return (
    <div className="space-y-4" data-testid="api-keys">
      <p className="text-sm"><a className="text-accent underline" href="/docs/api">API reference and curl examples</a></p>
      {canManage ? (
        <form onSubmit={create} className="flex flex-wrap items-end gap-3" data-testid="api-key-form">
          <label className="min-w-56 flex-1"><span className={fieldLabel}>Name</span><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CI pipeline" maxLength={80} required /></label>
          <label><span className={fieldLabel}>Repo</span>
            <select className={selectCls} value={repoId} onChange={(e) => setRepoId(Number(e.target.value))}>{repos.map((r) => <option key={r.id} value={r.id}>{r.repo} (id {r.id})</option>)}</select></label>
          <button className={primaryBtn} disabled={busy || !repos.length}>Generate key</button>
        </form>
      ) : <p className="text-sm text-fg-soft" data-testid="api-keys-readonly">Only team leads and the designated lead can create or revoke API keys.</p>}
      {error && <p className={errText} role="alert">{error}</p>}
      {fresh && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm" data-testid="api-key-once">
          <p className="font-medium">Copy this key now. It won&apos;t be shown again.</p>
          <code className="mt-2 block break-all rounded bg-bg px-2 py-1 font-mono">{fresh.plaintext}</code>
          <p className="mt-2 text-fg-soft">Base URL: <code className="font-mono">/api/v1/teams/{teamId}/repos/{fresh.key.repoId}</code></p>
          <div className="mt-2 flex gap-2"><button type="button" className={ghostBtn} onClick={() => navigator.clipboard?.writeText(fresh.plaintext)}>Copy</button><button type="button" className={ghostBtn} onClick={() => setFresh(null)}>Done</button></div>
        </div>
      )}
      <div className={tableWrap}>
        <table className={tableCls} data-testid="api-keys-table">
          <thead className={theadCls}><tr><th className={th}>Name</th><th className={th}>Key</th><th className={th}>Repo</th><th className={th}>Created</th><th className={th}>Last used</th><th className={th}>Status</th>{canManage && <th className={th} />}</tr></thead>
          <tbody>
            {keys.length === 0 && <tr><td className={td} colSpan={7}>No API keys yet.</td></tr>}
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-border last:border-0">
                <td className={td}>{k.name}</td>
                <td className={`${td} font-mono`}>{k.prefix}…</td>
                <td className={`${td} font-mono`}>{k.repo} <span className="text-subtle">#{k.repoId}</span></td>
                <td className={td}>{when(k.createdAt)}<div className="text-xs text-subtle">{k.createdBy ?? "unknown"}</div></td>
                <td className={td}>{when(k.lastUsedAt)}</td>
                <td className={td}>{k.revokedAt ? <span className="text-danger">revoked {when(k.revokedAt)}</span> : <span className="text-success">active</span>}</td>
                {canManage && <td className={td}>{!k.revokedAt && <button className={subtleDangerBtn} onClick={() => revoke(k)}>Revoke</button>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
