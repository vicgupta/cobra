"use client";
// Client pieces for SOP skills: editor with live validation, run action.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "./ui";
import { button, EmptyState, ghost, td, th } from "./form-ui";

const btn = "rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2 disabled:opacity-50";
const primary = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50";
const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm text-fg";

async function post(url: string, body: unknown, method = "POST") {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j: j as Record<string, unknown> };
}
const Errors = ({ e }: { e: string[] }) => e.length ? <ul className="mt-2 list-disc pl-5 text-sm text-danger" data-testid="errors">{e.map((x, i) => <li key={i}>{x}</li>)}</ul> : null;

export type Starter = { key: string; label: string; name?: string; description: string; body: string; kind?: "master" };

/** New/edit form: name, description and the plain-text SOP body (no JSON anywhere). The steps come from the headings
 * in the text when it is saved; the live check runs the same rules as the save, so "Ready to save" means it will save. */
export function SkillEditor({ id, initial, starters = [] }: { id?: number; initial?: { name: string; description: string; body: string }; starters?: Starter[] }) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [kind, setKind] = useState<"master" | undefined>(undefined); // only the master starter sets it; shown in the check
  const [check, setCheck] = useState<{ ok: boolean; errors?: string[]; steps?: string[] } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(async () => {
      if (id) { setCheck({ ok: body.trim().length > 0, errors: body.trim() ? [] : ["Steps: write at least one line saying what the skill should do."] }); return; }
      const r = await post("/api/skills/validate", { name, body, description, kind });
      setCheck(r.j as never);
    }, 400);
    return () => clearTimeout(t);
  }, [id, name, kind, body, description]);
  const [picked, setPicked] = useState("");
  const [filled, setFilled] = useState<{ name: string; description: string; body: string }>({ name: "", description: "", body: "" });
  /** Fill name, description and steps from a template (plain text, all editable). Asks first if the user typed something. */
  const start = (key: string) => {
    const s = starters.find((x) => x.key === key);
    const next = s ? { name: s.name ?? s.key, description: s.description, body: s.body } : { name: "", description: "", body: "" };
    const typed = (name && name !== filled.name) || (description && description !== filled.description) || (body.trim() && body !== filled.body);
    if (typed && !window.confirm("Replace what you've typed with this template?")) return;
    setPicked(key); setName(next.name); setDescription(next.description); setBody(next.body); setKind(s?.kind); setFilled(next);
  };
  const save = async () => {
    setBusy(true); setErrors([]);
    const r = id ? await post(`/api/skills/${id}`, { description, body }, "PUT") : await post("/api/skills", { name, description, body, kind });
    setBusy(false);
    if (!r.ok) { setErrors((r.j.errors as string[]) ?? [String(r.j.error ?? `error ${r.status}`)]); return; }
    const sid = (r.j.skill as { id: number }).id;
    router.push(`/agents/skills/${sid}`); router.refresh();
  };
  return (
    <div className="space-y-4">
      {!id && starters.length > 0 && <div className="text-sm">
        <label className="flex flex-wrap items-center gap-2"><span className="text-muted">Start from a template</span>
          <select className="rounded-md border border-border-strong bg-bg px-3 py-1.5 text-sm text-fg" data-testid="template" value={picked} onChange={(e) => start(e.target.value)}>
            <option value="">Blank</option>
            {starters.map((s) => <option key={s.key} value={s.key}>{s.label} · {s.description}</option>)}
          </select>
        </label>
        <p className="mt-1 text-xs text-subtle">Templates just fill in text — edit anything. Each heading becomes a step.</p>
      </div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Name<input className={input} aria-describedby="skill-name-hint" value={name} disabled={!!id} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))} placeholder="release-checklist" />{!id && <span id="skill-name-hint" className="mt-1 block text-xs text-subtle">Lowercase letters, numbers and dashes</span>}</label>
        <label className="text-sm">Description<input className={input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line: what this skill does" /></label>
      </div>
      <label className="block text-sm">Steps <span className="text-xs text-subtle">Plain text. Each heading becomes a step, in order; with no headings the whole text is one step.</span>
        <textarea className={`${input} h-64 font-mono`} value={body} onChange={(e) => setBody(e.target.value)} placeholder={"# My SOP\n\nOne line is enough."} />
      </label>
      <div className="rounded-md border border-border p-3 text-sm" data-testid="live-validation">
        {!check ? <span className="text-subtle">Checking…</span> : check.ok
          ? <span className="text-success">Ready to save{check.steps?.length ? <span className="text-muted"> · {kind === "master" ? "master skill workflow: " : ""}{check.steps.length === 1 ? "1 step" : `${check.steps.length} steps`}: {check.steps.join(" → ")}</span> : null}</span>
          : <><span className="text-danger">Can&apos;t save yet</span><Errors e={check.errors ?? []} /></>}
      </div>
      <Errors e={errors} />
      <div className="flex gap-2"><button className={primary} disabled={busy || (!id && !name) || (!!check && !check.ok)} onClick={save}>{id ? "Save changes" : "Create skill"}</button></div>
    </div>
  );
}

export type InputDef = { type: "string" | "number" | "boolean"; required?: boolean; default?: string | number | boolean; description?: string };

/** Run form: test run (dry run) or real run. Any team member, no approval. */
export function RunSkill({ id, inputs }: { id: number; inputs: Record<string, InputDef> }) {
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
      <label className="block text-sm">Repo <span className="text-xs text-subtle">optional, owner/name</span><input className={input} value={repo} onChange={(e) => setRepo(e.target.value)} /></label>
      <div className="flex items-center gap-3 text-sm">
        <label><input type="radio" checked={mode === "simulated"} onChange={() => setMode("simulated")} /> Test run</label>
        <label><input type="radio" checked={mode === "real"} onChange={() => setMode("real")} /> Real run</label>
        <button className={primary} onClick={go}>{mode === "real" ? "Start real run" : "Start test run"}</button>
      </div>
      <Errors e={err} />
    </div>
  );
}

/** POST to an action endpoint, then refresh (request review, admin re-review). */
export function ActionButton({ url, label, body = {}, testid }: { url: string; label: string; body?: unknown; testid?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string[]>([]);
  return <span><button className={btn} disabled={busy} data-testid={testid} onClick={async () => { setBusy(true); const r = await post(url, body); setBusy(false); if (!r.ok) setErr((r.j.errors as string[]) ?? [String(r.j.error)]); else router.refresh(); }}>{label}</button><Errors e={err} /></span>;
}


export type SkillRow = { id: number; name: string; kind: string; version: number; description: string; steps: number; canEdit: boolean };

/** Agents / Skills list: same count row, primary button, table and empty state as Agents / Agents. */
export function SkillsList({ rows }: { rows: SkillRow[] }) {
  if (rows.length === 0) return <EmptyState title="No skills yet" body="A skill is step-by-step instructions an agent can follow. Write a routine once and your whole team can run it." action={<Link className={button} href="/agents/skills/new">Create your first skill</Link>} />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><p className="text-sm text-subtle">{rows.length} {rows.length === 1 ? "skill" : "skills"}</p><Link className={button} href="/agents/skills/new">New skill</Link></div>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-border"><tr><th scope="col" className={th}>Skill</th><th scope="col" className={th}>Steps</th><th scope="col" className={th}>Version</th><th scope="col" className={th}><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y divide-border">{rows.map((r) => (
            <tr key={r.id} data-skill={r.name}>
              <td className={td}><div className="font-medium text-fg"><Link className="hover:underline" href={`/agents/skills/${r.id}`}>{r.name}</Link>{r.kind === "master" && <> <Badge tone="violet">master</Badge></>}</div>{r.description && <div className="max-w-md text-xs text-subtle">{r.description}</div>}</td>
              <td className={`${td} text-fg-soft`}>{r.steps}</td>
              <td className={`${td} text-fg-soft`}>v{r.version}</td>
              <td className={`${td} text-right`}><span className="inline-flex gap-1">
                <Link className={button} href={`/agents/skills/${r.id}`}>Run</Link>
                {r.canEdit ? <Link className={ghost} href={`/agents/skills/${r.id}/edit`}>Edit</Link> : <span className="px-2 py-1.5 text-xs text-subtle" data-run-only>View only</span>}
              </span></td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}
