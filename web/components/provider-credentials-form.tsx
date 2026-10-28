"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ProviderDefaultsForm } from "./provider-form";
import { ghostBtn, inputCls, primaryBtn, selectCls, tableCls, th, theadCls } from "./styles";


async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: r.ok, error: d.error ?? (r.ok ? undefined : `HTTP ${r.status}`) };
}

const MODE_LABEL: Record<string, string> = { auto: "Auto", api_key: "API key", subscription: "Subscription" };
const TYPE_LABEL: Record<string, string> = { api_key: "API key", subscription: "Subscription" };

/** One credential slot as sent to the client. Never carries the secret: only set/source/last4. */
export type CredRow = { engine: string; provider: string; cli: string | null; mode: string; modes: string[]; name: string; label: string; type: string; set: boolean; source: "stored" | "env" | null; last4: string | null; multiline: boolean; meta: string | null };

/** Team provider credentials, laid out like Settings > Repos: one row per credential slot, Repos-style row buttons,
 *  inputs open only on click (input + Save + Cancel). `canManage` false (system admins viewing another team): text only. */
export function CredentialsTable({ rows, canManage }: { rows: CredRow[]; canManage: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null); // `${engine}:${name}`
  const [value, setValue] = useState("");
  const [editMode, setEditMode] = useState<string | null>(null); // engine
  const [modeVal, setModeVal] = useState("auto");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (r: { ok: boolean; error?: string }, ok: string) => { if (!r.ok) { setNotice(null); setError(r.error ?? "Failed"); return false; } setError(null); setNotice(ok); router.refresh(); return true; };
  const put = async (c: CredRow, v: string | null) => { if (done(await call(`/api/providers/${c.engine}/credentials`, "PUT", { name: c.name, value: v }), v ? `${c.label} saved.` : `${c.label} cleared.`)) { setEditing(null); setValue(""); } };
  const saveMode = async (engine: string) => { if (done(await call(`/api/providers/${engine}/auth`, "PUT", { mode: modeVal }), "Auth method updated.")) setEditMode(null); };
  const first = new Set<string>(); const span: Record<string, number> = {};
  rows.forEach((r) => { span[r.engine] = (span[r.engine] ?? 0) + 1; });
  return (
    <div className="space-y-3">
      <div className="-mx-5 overflow-x-auto"><table className={tableCls} data-credentials-table>
        <thead className={theadCls}><tr><th scope="col" className={`${th} whitespace-nowrap`}>Provider</th><th scope="col" className={`${th} whitespace-nowrap`}>Credential</th><th scope="col" className={`${th} whitespace-nowrap`}>Status</th><th scope="col" className={`${th} whitespace-nowrap`}>Used by method</th>{canManage && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody className="divide-y divide-border">{rows.map((c) => {
          const key = `${c.engine}:${c.name}`, isFirst = !first.has(c.engine); first.add(c.engine);
          const active = c.mode === "auto" || c.mode === c.type;
          return (
            <tr key={key} data-cred-slot={c.name} className="transition-colors hover:bg-surface-2/40">
              {isFirst && <td rowSpan={span[c.engine]} className="px-4 py-3 align-top" data-cred-provider={c.engine}>
                <div className="whitespace-nowrap font-medium text-fg">{c.provider}</div>
                {c.cli && <div className="mt-0.5 whitespace-nowrap font-mono text-xs text-subtle">{c.cli}</div>}
                {editMode === c.engine ? (
                  <form className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void saveMode(c.engine); }}>
                    <select aria-label={`${c.provider} auth method`} className={`${selectCls} text-xs`} value={modeVal} onChange={(e) => setModeVal(e.target.value)}>{c.modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m] ?? m}</option>)}</select>
                    <button className={primaryBtn}>Save</button>
                    <button type="button" className={ghostBtn} onClick={() => setEditMode(null)}>Cancel</button>
                  </form>
                ) : <div className="mt-1 whitespace-nowrap text-xs text-subtle" data-auth-mode={c.engine}>Auth method: <span className="text-fg-soft">{MODE_LABEL[c.mode] ?? c.mode}</span></div>}
              </td>}
              <td className="px-4 py-3 align-top"><div className="font-medium text-fg-soft">{c.label}</div><div className="font-mono text-xs text-subtle">{c.name}</div></td>
              <td className="px-4 py-3 align-top text-xs">
                {editing === key ? (
                  <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void put(c, value.trim()); }}>
                    {c.multiline
                      ? <textarea aria-label={`New ${c.label}`} autoComplete="off" spellCheck={false} rows={2} className={`${inputCls} text-xs [-webkit-text-security:disc]`} placeholder="paste ~/.codex/auth.json" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
                      : <input type="password" autoComplete="off" aria-label={`New ${c.label}`} className={`${inputCls} text-xs`} placeholder="new token" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />}
                    <button className={primaryBtn} disabled={!value.trim()}>Save</button>
                    <button type="button" className={ghostBtn} onClick={() => { setEditing(null); setValue(""); }}>Cancel</button>
                  </form>
                ) : <>
                  <span data-cred-status={!c.set ? "unset" : c.source} className={`whitespace-nowrap ${c.source === "stored" ? "font-mono text-success" : c.source === "env" ? "text-fg-soft" : "text-subtle"}`}>{c.source === "stored" ? (c.last4 ? `Set ••••${c.last4}` : "Set") : c.source === "env" ? "From server env" : "—"}</span>
                  {c.meta && <div className="mt-0.5 text-subtle">{c.meta}</div>}
                </>}
              </td>
              <td className="px-4 py-3 align-top text-xs whitespace-nowrap"><span className={active ? "text-fg-soft" : "text-subtle"}>{TYPE_LABEL[c.type] ?? c.type}</span>{!active && <span className="text-subtle"> · not used now</span>}</td>
              {canManage && <td className="px-4 py-3 align-top text-right">{editing !== key && editMode !== c.engine && (
                <span className="inline-flex gap-2 whitespace-nowrap">
                  <button className={ghostBtn} onClick={() => { setEditing(key); setValue(""); setEditMode(null); }}>{c.source === "stored" ? "Replace token" : "Set token"}</button>
                  {c.source === "stored" && <button className={ghostBtn} onClick={() => void put(c, null)}>Clear token</button>}
                  {isFirst && c.modes.length > 1 && <button className={ghostBtn} onClick={() => { setEditMode(c.engine); setModeVal(c.mode); setEditing(null); }}>Edit method</button>}
                </span>)}</td>}
            </tr>
          );
        })}</tbody>
      </table></div>
      {notice && <p className="text-sm text-success">{notice}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

/** Repos-style "Edit defaults" row action (system admins): button swaps in the form + Cancel. */
export function DefaultsAction({ engine, models, tiers, current }: { engine: string; models: string[]; tiers: string[]; current: { model: string | null; effort: string | null } }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className={`${ghostBtn} whitespace-nowrap`} onClick={() => setOpen(true)}>Edit defaults</button>;
  return <div className="flex items-end justify-end gap-2"><ProviderDefaultsForm engine={engine} models={models} tiers={tiers} current={current} /><button type="button" className={ghostBtn} onClick={() => setOpen(false)}>Cancel</button></div>;
}

/** Max 3 model chips + "+N more". */
export function ModelChips({ models }: { models: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? models : models.slice(0, 3);
  return <div className="flex flex-wrap items-center gap-1">{shown.map((m) => <span key={m} className="whitespace-nowrap rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg-soft">{m}</span>)}
    {models.length > 3 && <button type="button" className="whitespace-nowrap text-xs text-subtle hover:text-fg" onClick={() => setAll(!all)}>{all ? "show less" : `+${models.length - 3} more`}</button>}</div>;
}

/** A saved custom provider as sent to the client: key status only (set; last4 for team members), never the key. */
export type CustomRow = { id: string; name: string; baseUrl: string; models: string[]; keySet: boolean; last4: string | null };
type TestOut = { ok: true; modelCount: number | null; ms: number } | { ok: false; error: string };

async function runTest(url: string, body?: unknown): Promise<TestOut> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; modelCount?: number | null; ms?: number };
    if (r.ok && d.ok) return { ok: true, modelCount: d.modelCount ?? null, ms: d.ms ?? 0 };
    return { ok: false, error: d.error ?? `HTTP ${r.status}` };
  } catch { return { ok: false, error: "Could not reach the server" }; }
}

/** Inline result, like the Repos access check: green "Connected · N models found · 412 ms" or the red error. */
export function TestResultLine({ r }: { r: TestOut | "running" | null }) {
  if (!r) return null;
  if (r === "running") return <p className="text-xs text-subtle" role="status">Testing…</p>;
  return r.ok
    ? <p className="text-xs text-success" role="status" data-test-result="ok">Connected{r.modelCount !== null ? ` · ${r.modelCount} model${r.modelCount === 1 ? "" : "s"} found` : ""} · {r.ms} ms</p>
    : <p className="text-xs text-danger" role="alert" data-test-result="error">{r.error}</p>;
}

/** Custom OpenAI-compatible providers for this team. Team members: add / test / edit models / replace key / remove.
 *  `canManage` false (system admins outside the team): read-only list. */
export function CustomProvidersTable({ rows, canManage }: { rows: CustomRow[]; canManage: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", id: "", baseUrl: "", models: "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftTest, setDraftTest] = useState<TestOut | "running" | null>(null);
  const [rowTest, setRowTest] = useState<Record<string, TestOut | "running">>({});
  const [editing, setEditing] = useState<{ id: string; what: "key" | "models" } | null>(null);
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => { setForm({ ...form, [k]: e.target.value }); setDraftTest(null); };

  async function add(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await call("/api/custom-providers", "POST", form);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "failed");
    setForm({ name: "", id: "", baseUrl: "", models: "", apiKey: "" }); setDraftTest(null); router.refresh();
  }
  async function testDraft() {
    setDraftTest("running");
    setDraftTest(await runTest("/api/custom-providers/test", { baseUrl: form.baseUrl, apiKey: form.apiKey, models: form.models.split(/[\s,]+/).filter(Boolean).slice(0, 1) }));
  }
  async function testRow(id: string) {
    setRowTest((s) => ({ ...s, [id]: "running" }));
    const r = await runTest(`/api/custom-providers/${encodeURIComponent(id)}/test`);
    setRowTest((s) => ({ ...s, [id]: r }));
  }
  async function save(id: string) {
    if (!editing) return;
    const r = await call(`/api/custom-providers/${encodeURIComponent(id)}`, "PUT", editing.what === "key" ? { apiKey: value } : { models: value });
    if (!r.ok) return setRowError((s) => ({ ...s, [id]: r.error ?? "failed" }));
    setEditing(null); setValue(""); setRowError((s) => ({ ...s, [id]: "" })); router.refresh();
  }
  async function remove(id: string) {
    const r = await call(`/api/custom-providers/${encodeURIComponent(id)}`, "DELETE");
    setConfirm(null);
    if (!r.ok) return setRowError((s) => ({ ...s, [id]: r.error ?? "failed" }));
    router.refresh();
  }

  return (
    <div className="space-y-3" data-custom-providers>
      {rows.length > 0 && <div className="-mx-5 overflow-x-auto"><table className={tableCls}>
        <thead className={theadCls}><tr>{["Name", "ID", "Base URL", "Models", "Key"].map((h) => <th key={h} scope="col" className={`${th} whitespace-nowrap`}>{h}</th>)}{canManage && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody className="divide-y divide-border">{rows.map((p) => {
          const ed = editing?.id === p.id ? editing.what : null;
          return (
          <tr key={p.id} data-custom-provider={p.id} className="transition-colors hover:bg-surface-2/40">
            <td className="px-4 py-3 align-top whitespace-nowrap font-medium text-fg">{p.name}</td>
            <td className="px-4 py-3 align-top font-mono text-xs text-subtle">{p.id}</td>
            <td className="px-4 py-3 align-top font-mono text-xs text-fg-soft">{p.baseUrl}</td>
            <td className="px-4 py-3 align-top"><ModelChips models={p.models} /></td>
            <td className="px-4 py-3 align-top text-xs"><span className={p.keySet ? "whitespace-nowrap font-mono text-success" : "text-subtle"}>{p.keySet ? (p.last4 ? `Set ••••${p.last4}` : "Set") : "—"}</span></td>
            {canManage && <td className="px-4 py-3 align-top text-right"><div className="flex flex-col items-end gap-2">
              {ed ? (
                <span className="inline-flex gap-2 whitespace-nowrap">
                  <input aria-label={ed === "key" ? "New API key" : "Models"} type={ed === "key" ? "password" : "text"} autoComplete="off" className={`${inputCls} w-56`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={ed === "key" ? "New API key" : "models, comma-separated"} />
                  <button type="button" className={primaryBtn} onClick={() => save(p.id)}>Save</button>
                  <button type="button" className={ghostBtn} onClick={() => { setEditing(null); setValue(""); }}>Cancel</button>
                </span>
              ) : confirm === p.id ? (
                <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs"><span className="text-fg-soft">Remove {p.name} and its key?</span>
                  <button type="button" className={ghostBtn} onClick={() => remove(p.id)}>Remove</button>
                  <button type="button" className={ghostBtn} onClick={() => setConfirm(null)}>Cancel</button>
                </span>
              ) : (
                <span className="inline-flex gap-2 whitespace-nowrap">
                  <button type="button" className={ghostBtn} disabled={!p.keySet || rowTest[p.id] === "running"} title={p.keySet ? undefined : "Set a key first"} onClick={() => testRow(p.id)}>Test</button>
                  <button type="button" className={ghostBtn} onClick={() => { setEditing({ id: p.id, what: "key" }); setValue(""); }}>{p.keySet ? "Replace key" : "Set key"}</button>
                  <button type="button" className={ghostBtn} onClick={() => { setEditing({ id: p.id, what: "models" }); setValue(p.models.join(", ")); }}>Edit models</button>
                  <button type="button" className={ghostBtn} onClick={() => setConfirm(p.id)}>Remove</button>
                </span>
              )}
              <TestResultLine r={rowTest[p.id] ?? null} />
              {rowError[p.id] && <p className="text-xs text-danger" role="alert">{rowError[p.id]}</p>}
            </div></td>}
          </tr>);
        })}</tbody>
      </table></div>}
      {rows.length === 0 && <p className="text-sm text-subtle">No custom providers yet.</p>}
      {canManage ? (
        <form className="space-y-2" onSubmit={add} data-add-custom-provider>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <input aria-label="Name" className={inputCls} placeholder="Name" value={form.name} onChange={set("name")} required />
            <input aria-label="ID" className={`${inputCls} font-mono`} placeholder="id (slug)" value={form.id} onChange={set("id")} required />
            <input aria-label="Base URL" className={inputCls} placeholder="https://… (OpenAI-compatible)" value={form.baseUrl} onChange={set("baseUrl")} required />
            <input aria-label="Models" className={inputCls} placeholder="models, comma-separated" value={form.models} onChange={set("models")} required />
            <input aria-label="API key" type="password" autoComplete="off" className={inputCls} placeholder="API key" value={form.apiKey} onChange={set("apiKey")} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <TestResultLine r={draftTest} />
            {error && <p className="text-xs text-danger" role="alert">{error}</p>}
            <button type="button" className={ghostBtn} disabled={draftTest === "running" || !form.baseUrl || !form.apiKey || !form.models} onClick={testDraft}>Test connection</button>
            <button className={primaryBtn} disabled={busy}>Add provider</button>
          </div>
        </form>
      ) : <p className="text-xs text-subtle" data-custom-readonly>Only team members can add custom providers.</p>}
    </div>
  );
}
