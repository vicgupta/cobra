"use client";

// Issues and pull requests: forms for issues, agent issues, comments, Create PR, merge, and the designated lead.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

const input = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50";

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
  const status = <>{error && <p role="alert" className="text-sm text-rose-300">{error}</p>}{note && <p className="text-sm text-emerald-300">{note}</p>}</>;
  return { busy, run, status };
}

export type AgentChoice = { name: string; engine: string };

/** Engine or team agent picker; value "engine:codex" or "agent:<name>". */
function AgentPicker({ agents, value, onChange }: { agents: AgentChoice[]; value: string; onChange: (v: string) => void }) {
  return (
    <select aria-label="Agent" className={input} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="engine:claude-code">Claude Code</option><option value="engine:codex">Codex</option>
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
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void m.run(() => call(`/api/github/${repo}/issues`, "POST", { title, body }), (d) => { setTitle(""); setBody(""); router.refresh(); return <>Opened <Link className="underline" href={`/issues/${repo}/${String(d.number)}`}>#{String(d.number)}</Link></>; }); }}>
        <h3 className="text-sm font-medium">New issue</h3>
        <input aria-label="Title" className={input} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea aria-label="Body" className={`${input} h-24`} placeholder="Describe the issue (markdown)" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className={button} disabled={m.busy || !title.trim()}>Create issue</button>{m.status}
      </form>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void a.run(() => call(`/api/github/${repo}/issues/agent`, "POST", { ...pickBody(who), prompt, mode }), (d) => <>Run started: <Link className="underline" href={`/runs/${String(d.runId)}`}>{String(d.runId)}</Link>. The issue opens when it succeeds.</>); }}>
        <h3 className="text-sm font-medium">Let an agent write an issue</h3>
        <div className="grid grid-cols-2 gap-2"><AgentPicker agents={agents} value={who} onChange={setWho} />
          <select aria-label="Mode" className={input} value={mode} onChange={(e) => setMode(e.target.value)}><option value="simulated">Simulated</option><option value="real">Real</option></select></div>
        <textarea aria-label="What should the agent look into" className={`${input} h-24`} placeholder="What should the agent look into?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button className={button} disabled={a.busy || !prompt.trim()}>Run agent</button>{a.status}
      </form>
    </div>
  );
}

export function CommentForm({ repo, number }: { repo: string; number: number }) {
  const router = useRouter();
  const c = useAction();
  const [body, setBody] = useState("");
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void c.run(() => call(`/api/github/${repo}/comments/${number}`, "POST", { body }), () => { setBody(""); router.refresh(); return "Comment posted"; }); }}>
      <textarea aria-label="Comment" className={`${input} h-20`} placeholder="Leave a comment" value={body} onChange={(e) => setBody(e.target.value)} />
      <button className={button} disabled={c.busy || !body.trim()}>Comment</button>{c.status}
    </form>
  );
}

export function CreatePrForm({ repo, number, agents }: { repo: string; number: number; agents: AgentChoice[] }) {
  const c = useAction();
  const [who, setWho] = useState("engine:claude-code"), [instructions, setInstructions] = useState("");
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void c.run(() => call(`/api/github/${repo}/issues/${number}/pr`, "POST", { ...pickBody(who), instructions }), (d) => <>Real run started on <code>cobra/{String(d.runId)}</code>: <Link className="underline" href={`/runs/${String(d.runId)}`}>watch it</Link>. The PR opens when it finishes.</>); }}>
      <AgentPicker agents={agents} value={who} onChange={setWho} />
      <textarea aria-label="Extra instructions" className={`${input} h-16`} placeholder="Extra instructions (optional)" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      <button className={button} disabled={c.busy}>Create PR</button>{c.status}
      <p className="text-xs text-zinc-500">Runs the agent for real on a <code>cobra/&lt;run-id&gt;</code> branch, then opens a PR that closes this issue. No approval needed.</p>
    </form>
  );
}

export function MergeButton({ repo, number, base }: { repo: string; number: number; base: string }) {
  const router = useRouter();
  const c = useAction();
  return (
    <div className="space-y-2">
      <button className={button} disabled={c.busy} onClick={() => { if (confirm(`Merge #${number} into ${base}?`)) void c.run(() => call(`/api/github/${repo}/pulls/${number}/merge`, "POST", {}), (d) => { router.refresh(); return `Merged (${String(d.sha).slice(0, 12)})`; }); }}>Merge into {base}</button>
      {c.status}
    </div>
  );
}

export function DesignatedLeadForm({ leads, current }: { leads: Array<{ id: number; email: string; name: string }>; current: number | null }) {
  const router = useRouter();
  const c = useAction();
  const [v, setV] = useState(current === null ? "" : String(current));
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void c.run(() => call("/api/team", "PUT", { designatedLeadUserId: v ? Number(v) : null }), () => { router.refresh(); return "Saved"; }); }}>
      <select aria-label="Designated lead" className={`${input} max-w-sm`} value={v} onChange={(e) => setV(e.target.value)}>
        <option value="">No designated lead</option>{leads.map((l) => <option key={l.id} value={l.id}>{l.name ? `${l.name} (${l.email})` : l.email}</option>)}
      </select>
      <button className={button} disabled={c.busy}>Save</button>{c.status}
    </form>
  );
}
