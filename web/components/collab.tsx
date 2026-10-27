"use client";

// Issues and pull requests: forms for issues, agent issues, comments, Create PR, merge, and the designated lead.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Children, useState, type ReactNode } from "react";
import { ENGINES, ENGINE_LABEL } from "@/lib/engines";

const input = "w-full min-h-10 rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm leading-relaxed placeholder:text-faint transition-colors focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/25";
const button = "inline-flex min-h-10 items-center justify-center rounded-lg bg-accent-solid px-4 py-2 text-sm font-medium text-on-accent shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50";
const fieldLabel = "mb-1.5 block text-xs font-medium text-fg-soft";
const seg = (on: boolean) => `inline-flex min-h-9 flex-1 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 sm:flex-none ${on ? "bg-bg text-fg shadow-sm ring-1 ring-border-strong" : "text-muted hover:text-fg"}`;

/** Segmented control (tabs) for switching between views; used by the create card and list filters. */
export function Segmented({ label, children }: { label: string; children: ReactNode }) {
  return <div role="tablist" aria-label={label} className="flex w-full gap-1 rounded-lg bg-surface-2 p-1 sm:inline-flex sm:w-auto">{children}</div>;
}

/** Client-side text filter over already-loaded rows (no extra API calls). `texts[i]` is the searchable text of child i. */
export function FilterList({ texts, placeholder, toolbar, empty, noun, children }: { texts: string[]; placeholder: string; toolbar?: ReactNode; empty: ReactNode; noun: string; children?: ReactNode }) {
  const [q, setQ] = useState("");
  const items = Children.toArray(children);
  const needle = q.trim().toLowerCase();
  const shown = items.filter((_, i) => !needle || (texts[i] ?? "").toLowerCase().includes(needle));
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {toolbar}
        <label className="relative block sm:ml-auto sm:w-72">
          <span className="sr-only">Filter {noun}</span>
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">⌕</span>
          <input type="search" className={`${input} pl-8`} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {items.length === 0 ? empty : shown.length === 0
        ? <div className="rounded-lg border border-dashed border-border-strong px-6 py-8 text-center text-sm text-subtle">No {noun} match “{q}”. <button type="button" className="ml-1 font-medium text-accent underline" onClick={() => setQ("")}>Clear filter</button></div>
        : <ul className="-mx-3 divide-y divide-border sm:-mx-4">{shown}</ul>}
      {needle && shown.length > 0 && <p className="text-xs text-subtle" aria-live="polite">Showing {shown.length} of {items.length} {noun}</p>}
    </div>
  );
}

async function call(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, data: (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as Record<string, unknown> & { error?: string } };
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<ReactNode>(null);
  const run = async (f: () => Promise<{ ok: boolean; data: { error?: string } & Record<string, unknown> }>, done?: (d: Record<string, unknown>) => ReactNode) => {
    setBusy(true); setError(null); setNote(null);
    try { const r = await f(); if (!r.ok) setError(r.data.error ?? "Failed"); else setNote(done?.(r.data) ?? null); } finally { setBusy(false); }
    return true;
  };
  const status = <>{error && <p role="alert" className="text-sm text-danger">{error}</p>}{note && <p className="text-sm text-success">{note}</p>}</>;
  return { busy, run, status };
}

export type AgentChoice = { name: string; engine: string };

/** Engine or team agent picker; value "engine:codex" or "agent:<name>". */
function AgentPicker({ agents, value, onChange }: { agents: AgentChoice[]; value: string; onChange: (v: string) => void }) {
  return (
    <select aria-label="Agent" className={input} value={value} onChange={(e) => onChange(e.target.value)}>
      {ENGINES.map((e) => <option key={e} value={`engine:${e}`}>{ENGINE_LABEL[e]}</option>)}
      {agents.length > 0 && <optgroup label="Team agents">{agents.map((a) => <option key={a.name} value={`agent:${a.name}`}>{a.name} ({a.engine})</option>)}</optgroup>}
    </select>
  );
}
const pickBody = (v: string) => (v.startsWith("agent:") ? { agent: v.slice(6) } : { engine: v.slice(7) });

export function NewIssueForms({ repo, agents }: { repo: string; agents: AgentChoice[] }) {
  const router = useRouter();
  const m = useAction(), a = useAction();
  const [title, setTitle] = useState(""), [body, setBody] = useState("");
  const [who, setWho] = useState("engine:claude-code"), [prompt, setPrompt] = useState(""), [mode, setMode] = useState("simulated");
  const [tab, setTab] = useState<"manual" | "agent">("manual");
  return (
    <div className="space-y-5">
      <Segmented label="How to create the issue">
        <button type="button" role="tab" aria-selected={tab === "manual"} className={seg(tab === "manual")} onClick={() => setTab("manual")}>New issue</button>
        <button type="button" role="tab" aria-selected={tab === "agent"} className={seg(tab === "agent")} onClick={() => setTab("agent")}>Let an agent write an issue</button>
      </Segmented>
      <form hidden={tab !== "manual"} className="space-y-4" onSubmit={(e) => { e.preventDefault(); void m.run(() => call(`/api/github/${repo}/issues`, "POST", { title, body }), (d) => { setTitle(""); setBody(""); router.refresh(); return <>Opened <Link className="underline" href={`/repos/issues/${repo}/${String(d.number)}`}>#{String(d.number)}</Link></>; }); }}>
        <div><label className={fieldLabel} htmlFor="ni-title">Title</label>
          <input id="ni-title" aria-label="Title" className={input} placeholder="Short, specific summary" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div><label className={fieldLabel} htmlFor="ni-body">Description <span className="font-normal text-subtle">(markdown, optional)</span></label>
          <textarea id="ni-body" aria-label="Body" className={`${input} h-32`} placeholder="Describe the issue (markdown)" value={body} onChange={(e) => setBody(e.target.value)} /></div>
        <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={m.busy || !title.trim()}>{m.busy ? "Creating…" : "Create issue"}</button>{m.status}</div>
      </form>
      <form hidden={tab !== "agent"} className="space-y-4" onSubmit={(e) => { e.preventDefault(); void a.run(() => call(`/api/github/${repo}/issues/agent`, "POST", { ...pickBody(who), prompt, mode }), (d) => <>Run started: <Link className="underline" href={`/runs/${String(d.runId)}`}>{String(d.runId)}</Link>. The issue opens when it succeeds.</>); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><span className={fieldLabel}>Agent</span><AgentPicker agents={agents} value={who} onChange={setWho} /></div>
          <div><label className={fieldLabel} htmlFor="ai-mode">Mode</label>
            <select id="ai-mode" aria-label="Mode" className={input} value={mode} onChange={(e) => setMode(e.target.value)}><option value="simulated">Simulated</option><option value="real">Real</option></select></div>
        </div>
        <div><label className={fieldLabel} htmlFor="ai-prompt">What should the agent look into?</label>
          <textarea id="ai-prompt" aria-label="What should the agent look into" className={`${input} h-32`} placeholder="e.g. Find flaky tests in the runner and file an issue with repro steps" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></div>
        <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={a.busy || !prompt.trim()}>{a.busy ? "Starting…" : "Run agent"}</button>{a.status}</div>
      </form>
    </div>
  );
}

export function CommentForm({ repo, number }: { repo: string; number: number }) {
  const router = useRouter();
  const c = useAction();
  const [body, setBody] = useState("");
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void c.run(() => call(`/api/github/${repo}/comments/${number}`, "POST", { body }), () => { setBody(""); router.refresh(); return "Comment posted"; }); }}>
      <textarea aria-label="Comment" className={`${input} h-28`} placeholder="Leave a comment" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex flex-wrap items-center justify-end gap-3">{c.status}<button className={button} disabled={c.busy || !body.trim()}>{c.busy ? "Posting…" : "Comment"}</button></div>
    </form>
  );
}

export function CreatePrForm({ repo, number, agents }: { repo: string; number: number; agents: AgentChoice[] }) {
  const c = useAction();
  const [who, setWho] = useState("engine:claude-code"), [instructions, setInstructions] = useState("");
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void c.run(() => call(`/api/github/${repo}/issues/${number}/pr`, "POST", { ...pickBody(who), instructions }), (d) => <>Real run started on <code>cobra/{String(d.runId)}</code>: <Link className="underline" href={`/runs/${String(d.runId)}`}>watch it</Link>. The PR opens when it finishes.</>); }}>
      <div><span className={fieldLabel}>Agent</span><AgentPicker agents={agents} value={who} onChange={setWho} /></div>
      <div><label className={fieldLabel} htmlFor="pr-instr">Extra instructions <span className="font-normal text-subtle">(optional)</span></label>
        <textarea id="pr-instr" aria-label="Extra instructions" className={`${input} h-24`} placeholder="Extra instructions (optional)" value={instructions} onChange={(e) => setInstructions(e.target.value)} /></div>
      <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={c.busy}>{c.busy ? "Starting…" : "Create PR"}</button>{c.status}</div>
      <p className="text-xs leading-relaxed text-subtle">Runs the agent for real on a <code>cobra/&lt;run-id&gt;</code> branch, then opens a PR that closes this issue. No approval needed.</p>
    </form>
  );
}

export function MergeButton({ repo, number, base }: { repo: string; number: number; base: string }) {
  const router = useRouter();
  const c = useAction();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className={button} disabled={c.busy} onClick={() => { if (confirm(`Merge #${number} into ${base}?`)) void c.run(() => call(`/api/github/${repo}/pulls/${number}/merge`, "POST", {}), (d) => { router.refresh(); return `Merged (${String(d.sha).slice(0, 12)})`; }); }}>Merge into {base}</button>
      {c.status}
    </div>
  );
}

/** Job 25: per-member controls on Settings > Team. The server enforces the same rules (lib/team.ts). */
export function MemberControls({ member, viewer, designatedId }: { member: { id: number; email: string; role: string }; viewer: { id: number; role: string }; designatedId: number | null }) {
  const router = useRouter();
  const c = useAction();
  const admin = viewer.role === "admin", lead = viewer.role === "team_lead";
  if (member.role === "admin" || member.id === 1) return <span className="text-xs text-faint">—</span>;
  const patch = (body: unknown, done: string) => void c.run(() => call(`/api/team/members/${member.id}`, "PATCH", body), () => { router.refresh(); return done; });
  const canPromote = (admin || lead) && member.role === "member";
  const canDemote = member.role === "team_lead" && (admin || (lead && member.id !== viewer.id && member.id !== designatedId));
  return (
    <span className="flex flex-wrap items-center gap-2">
      {canPromote && <button className={button} disabled={c.busy} onClick={() => patch({ role: "team_lead" }, "Promoted")}>Make team lead</button>}
      {canDemote && <button className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2 disabled:opacity-50" disabled={c.busy}
        onClick={() => { if (member.id !== designatedId || confirm(`${member.email} is the designated lead; demoting unsets that. Continue?`)) patch({ role: "member" }, "Demoted"); }}>Make member</button>}
      {c.status}
    </span>
  );
}
