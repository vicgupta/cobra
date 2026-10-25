"use client";

// Team agents: list, create, edit, delete, and a Run form per agent.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "./ui";

const input = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50";
const ghost = "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const ENGINE: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

export type AgentView = { name: string; engine: string; model: string | null; prompt: string; defaultRepo: string | null; contentHash: string; createdByEmail: string | null; canEdit: boolean };

async function call(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, data: (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as { error?: string; id?: string } };
}

function AgentForm({ initial, repos, models, onDone }: { initial?: AgentView; repos: string[]; models: Record<string, string[]>; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [engine, setEngine] = useState(initial?.engine ?? "claude-code");
  const [model, setModel] = useState(initial?.model ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [repo, setRepo] = useState(initial?.defaultRepo ?? "");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      const body = { name, engine, model: model || null, prompt, defaultRepo: repo || null };
      const r = initial ? await call(`/api/agents/${encodeURIComponent(initial.name)}`, "PATCH", body) : await call("/api/agents", "POST", body);
      if (!r.ok) return setError(r.data.error ?? "Failed");
      setError(null); if (!initial) { setName(""); setPrompt(""); setRepo(""); setModel(""); }
      onDone(); router.refresh();
    }}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <input aria-label="Agent name" name="name" className={input} placeholder="name (e.g. reviewer)" value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label="Engine" name="engine" className={input} value={engine} onChange={(e) => { setEngine(e.target.value); setModel(""); }}>
          <option value="claude-code">Claude Code</option><option value="codex">Codex</option>
        </select>
        <select aria-label="Model" name="model" className={input} value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">Default</option>{(models[engine] ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select aria-label="Default repo" name="defaultRepo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">No default repo</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <textarea aria-label="Prompt" name="prompt" className={`${input} h-28 font-mono`} placeholder="What this agent does" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="flex gap-2">
        <button className={button} disabled={!name.trim() || !prompt.trim()}>{initial ? "Save agent" : "Create agent"}</button>
        {initial && <button type="button" className={ghost} onClick={onDone}>Cancel</button>}
      </div>
      {initial && <p className="text-xs text-zinc-500">Changing the engine, model or prompt makes a new version: workflows that use this agent need approval again.</p>}
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    </form>
  );
}

function RunAgentForm({ agent, repos, onClose }: { agent: AgentView; repos: string[]; onClose: () => void }) {
  const [repo, setRepo] = useState(agent.defaultRepo ?? "");
  const [mode, setMode] = useState("simulated");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <form className="mt-2 space-y-2 rounded-md border border-zinc-800 p-3" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      const r = await call(`/api/agents/${encodeURIComponent(agent.name)}/runs`, "POST", { repo: repo || undefined, mode, instructions });
      setBusy(false);
      if (!r.ok || !r.data.id) return setError(r.data.error ?? "Failed");
      router.push(`/runs/${encodeURIComponent(r.data.id)}`);
    }}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select aria-label="Repo" name="repo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">No repo (scratch)</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input aria-label="Engine" className={`${input} text-zinc-400`} value={`${ENGINE[agent.engine] ?? agent.engine} · ${agent.model ?? "default"}`} readOnly />
        <select aria-label="Mode" name="mode" className={input} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="simulated">Simulated (records only)</option><option value="real">Real (runs the agent)</option>
        </select>
      </div>
      <textarea aria-label="Extra instructions" name="instructions" className={`${input} h-20`} placeholder="Optional extra instructions (appended to the agent's prompt)" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      <div className="flex gap-2"><button className={button} disabled={busy}>{busy ? "Starting…" : "Start run"}</button><button type="button" className={ghost} onClick={onClose}>Cancel</button></div>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    </form>
  );
}

export function AgentManager({ agents, repos, models }: { agents: AgentView[]; repos: string[]; models: Record<string, string[]> }) {
  const [open, setOpen] = useState<{ name: string; kind: "run" | "edit" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="space-y-4">
      {agents.length === 0 ? <p className="text-sm text-zinc-500">No agents yet.</p> : (
        <ul className="divide-y divide-zinc-800">{agents.map((a) => (
          <li key={a.name} className="py-3" data-agent={a.name}>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-mono font-medium">{a.name}</span>
              <Badge tone="blue">{ENGINE[a.engine] ?? a.engine}</Badge>
              <span className="font-mono text-xs text-zinc-300" data-model>{a.model ?? "default model"}</span>
              <span className="font-mono text-xs text-zinc-500" title="version (sha256 of engine + prompt + model)">v {a.contentHash.slice(0, 12)}</span>
              {a.defaultRepo && <span className="font-mono text-xs text-zinc-400">{a.defaultRepo}</span>}
              <span className="text-xs text-zinc-500">by {a.createdByEmail ?? "—"}</span>
              <span className="ml-auto flex gap-2">
                <button className={button} onClick={() => setOpen({ name: a.name, kind: "run" })}>Run</button>
                {a.canEdit && <button className={ghost} onClick={() => setOpen({ name: a.name, kind: "edit" })}>Edit</button>}
                {a.canEdit && <button className={ghost} onClick={async () => {
                  if (!confirm(`Delete agent ${a.name}? Workflows that use it will fail validation.`)) return;
                  const r = await call(`/api/agents/${encodeURIComponent(a.name)}`, "DELETE");
                  if (!r.ok) setError(r.data.error ?? "Failed"); else router.refresh();
                }}>Delete</button>}
              </span>
            </div>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs text-zinc-400">{a.prompt}</pre>
            {open?.name === a.name && open.kind === "run" && <RunAgentForm agent={a} repos={repos} onClose={() => setOpen(null)} />}
            {open?.name === a.name && open.kind === "edit" && <div className="mt-2"><AgentForm initial={a} repos={repos} models={models} onDone={() => setOpen(null)} /></div>}
          </li>))}</ul>
      )}
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <div className="border-t border-zinc-800 pt-4"><h3 className="mb-2 text-sm font-medium">New agent</h3><AgentForm repos={repos} models={models} onDone={() => {}} /></div>
    </div>
  );
}
