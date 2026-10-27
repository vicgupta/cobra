"use client";
// Client pieces for SOP skills: editor with live validation, run/approve actions.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const btn = "rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2 disabled:opacity-50";
const primary = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50";
const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm text-fg";

async function post(url: string, body: unknown, method = "POST") {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j: j as Record<string, unknown> };
}
const Errors = ({ e }: { e: string[] }) => e.length ? <ul className="mt-2 list-disc pl-5 text-sm text-danger" data-testid="errors">{e.map((x, i) => <li key={i}>{x}</li>)}</ul> : null;

export type Starter = { key: string; label: string; description: string; body: string; plan: string };

/** New/edit form: name, description and the plain-text SOP body (no JSON anywhere). A starter may carry a hidden plan; edits keep the stored plan. */
export function SkillEditor({ id, initial, starters = [] }: { id?: number; initial?: { name: string; description: string; body: string }; starters?: Starter[] }) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [plan, setPlan] = useState(""); // hidden: only a starter sets it (new skills); never shown
  const [check, setCheck] = useState<{ ok: boolean; errors?: string[]; steps?: number; derived?: boolean } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(async () => {
      let parsed: unknown = null;
      if (!id && plan.trim()) { try { parsed = JSON.parse(plan); } catch { parsed = null; } }
      const r = await post("/api/skills/validate", { plan: parsed, body, description });
      setCheck(r.j as never);
    }, 400);
    return () => clearTimeout(t);
  }, [id, plan, body, description]);
  const start = (s: Starter) => { setBody(s.body); setPlan(s.plan); if (!description) setDescription(s.description); };
  const save = async () => {
    setBusy(true); setErrors([]);
    let p: unknown = null;
    if (!id && plan.trim()) { try { p = JSON.parse(plan); } catch { p = null; } }
    const r = id ? await post(`/api/skills/${id}`, { description, body }, "PUT") : await post("/api/skills", { name, description, body, plan: p });
    setBusy(false);
    if (!r.ok) { setErrors((r.j.errors as string[]) ?? [String(r.j.error ?? `error ${r.status}`)]); return; }
    const sid = (r.j.skill as { id: number }).id;
    router.push(`/agents/skills/${sid}`); router.refresh();
  };
  return (
    <div className="space-y-4">
      {!id && starters.length > 0 && <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted">Start from:</span>{starters.map((s) => <button key={s.key} type="button" className={btn} onClick={() => start(s)} title={s.description}>{s.label}</button>)}</div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Name<input className={input} value={name} disabled={!!id} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="release-checklist" /></label>
        <label className="text-sm">Description<input className={input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line: what this SOP does" /></label>
      </div>
      <label className="block text-sm">SOP (plain text; headings become sections)
        <textarea className={`${input} h-64 font-mono`} value={body} onChange={(e) => setBody(e.target.value)} placeholder={"# My SOP\n\nOne line is enough."} />
      </label>
      <div className="rounded-md border border-border p-3 text-sm" data-testid="live-validation">
        {!check ? <span className="text-subtle">Checking…</span> : check.ok
          ? <span className="text-success">Ready to save</span>
          : <><span className="text-danger">Can&apos;t save yet</span><Errors e={check.errors ?? []} /></>}
      </div>
      <Errors e={errors} />
      <div className="flex gap-2"><button className={primary} disabled={busy || (!id && !name)} onClick={save}>{id ? "Save new version" : "Create skill"}</button></div>
    </div>
  );
}

export type InputDef = { type: "string" | "number" | "boolean"; required?: boolean; default?: string | number | boolean; description?: string };

/** Run form: simulated (dry run, allowed before approval) or real (needs the current hash approved). */
export function RunSkill({ id, inputs, approved }: { id: number; inputs: Record<string, InputDef>; approved: boolean }) {
  const router = useRouter();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(Object.entries(inputs).map(([k, d]) => [k, d.default === undefined ? "" : String(d.default)])));
  const [repo, setRepo] = useState("");
  const [mode, setMode] = useState<"simulated" | "real">("simulated");
  const [err, setErr] = useState<string[]>([]);
  const go = async () => {
    setErr([]);
    const r = await post(`/api/skills/${id}/run`, { inputs: vals, repo, mode });
    if (!r.ok) { setErr((r.j.errors as string[]) ?? [String(r.j.error)]); return; }
    router.push(String(r.j.url));
  };
  return (
    <div className="space-y-2" data-testid="run-form">
      {Object.entries(inputs).map(([k, d]) => <label key={k} className="block text-sm">{k}{d.required && " *"} <span className="text-xs text-subtle">{d.description}</span>
        <input className={input} value={vals[k] ?? ""} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></label>)}
      <label className="block text-sm">Repo (optional, owner/name)<input className={input} value={repo} onChange={(e) => setRepo(e.target.value)} /></label>
      <div className="flex items-center gap-3 text-sm">
        <label><input type="radio" checked={mode === "simulated"} onChange={() => setMode("simulated")} /> Simulated</label>
        <label className={approved ? "" : "text-subtle"}><input type="radio" disabled={!approved} checked={mode === "real"} onChange={() => setMode("real")} /> Real{!approved && " (needs approval)"}</label>
        <button className={primary} onClick={go}>Run</button>
      </div>
      <Errors e={err} />
    </div>
  );
}

export function Approve({ id }: { id: number }) {
  const router = useRouter();
  const [c, setC] = useState(""); const [err, setErr] = useState<string[]>([]);
  const d = async (decision: string) => { const r = await post(`/api/skills/${id}/approval`, { decision, comment: c }); if (!r.ok) setErr([String(r.j.error)]); else router.refresh(); };
  return <div className="space-y-2"><input className={input} placeholder="Comment (optional)" value={c} onChange={(e) => setC(e.target.value)} /><div className="flex gap-2"><button className={primary} onClick={() => d("approve")}>Approve this hash</button><button className={btn} onClick={() => d("reject")}>Reject</button></div><Errors e={err} /></div>;
}

/** POST to an action endpoint, then refresh (request review, admin re-review). */
export function ActionButton({ url, label, body = {}, testid }: { url: string; label: string; body?: unknown; testid?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string[]>([]);
  return <span><button className={btn} disabled={busy} data-testid={testid} onClick={async () => { setBusy(true); const r = await post(url, body); setBusy(false); if (!r.ok) setErr((r.j.errors as string[]) ?? [String(r.j.error)]); else router.refresh(); }}>{label}</button><Errors e={err} /></span>;
}

