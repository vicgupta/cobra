"use client";

// Team agents: list, create, edit, delete, and a Run form per agent.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "./ui";
import { ENGINES, ENGINE_LABEL, isEngine, UNSUPPORTED_ENGINE } from "@/lib/engines";

const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const ghost = "rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2 disabled:opacity-50";
const danger = "rounded-md border border-border-strong px-3 py-1.5 text-sm text-danger hover:bg-danger-soft disabled:opacity-50";
const dangerSolid = "rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50";
// Mirrors AGENT_PROMPT_MAX / AGENT_DESCRIPTION_MAX in lib/agents.ts (server-only module).
const PROMPT_MAX = 20000, DESC_MAX = 500;
const PROMPT_EXAMPLE = "You are a careful code reviewer. Read the diff on the current branch, list bugs, risky changes and missing tests, then suggest concrete fixes. Do not push or merge.";
const label = "block text-sm font-medium text-fg-soft";
const ENGINE: Record<string, string> = ENGINE_LABEL;

export type AgentView = { name: string; engine: string; model: string | null; description: string | null; prompt: string; defaultRepo: string | null; contentHash: string; createdByEmail: string | null; createdAt?: number; canEdit: boolean };

async function call(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, data: (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as { error?: string; id?: string } };
}

/** The engine's models (MVP build: Claude Code and Codex only). */
export function ModelPicker({ engine, models, value, onChange }: { engine: string; models: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <select aria-label="Model" name="model" className={input} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Default</option>
      {value && !models.includes(value) && <option value={value}>{value} (not available)</option>}
      <optgroup label={`${isEngine(engine) ? ENGINE_LABEL[engine] : engine} models`}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</optgroup>
    </select>
  );
}

function AgentForm({ initial, repos, models, onDone }: { initial?: AgentView; repos: string[]; models: Record<string, string[]>; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [engine, setEngine] = useState(initial?.engine ?? "claude-code");
  const [model, setModel] = useState(initial?.model ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [repo, setRepo] = useState(initial?.defaultRepo ?? "");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const idp = initial ? `agent-${initial.name}` : "agent-new";
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const body = { name, engine, model: model || null, description: description.trim() || null, prompt, defaultRepo: repo || null };
      const r = initial ? await call(`/api/agents/${encodeURIComponent(initial.name)}`, "PATCH", body) : await call("/api/agents", "POST", body);
      if (!r.ok) return setError(r.data.error ?? "Failed");
      setError(null); if (!initial) { setName(""); setPrompt(""); setDescription(""); setRepo(""); setModel(""); }
      onDone(); router.refresh();
    }}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <input aria-label="Agent name" name="name" className={input} placeholder="name (e.g. reviewer)" value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label="Engine" name="engine" className={input} value={engine} onChange={(e) => { setEngine(e.target.value); setModel(""); }}>
          {ENGINES.map((e) => <option key={e} value={e}>{ENGINE_LABEL[e]}</option>)}
        </select>
        <ModelPicker key={engine} engine={engine} models={models[engine] ?? []} value={model} onChange={setModel} />
        <select aria-label="Default repo" name="defaultRepo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">No default repo</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${idp}-desc`} className={label}>What this agent does <span className="font-normal text-subtle">(optional, shown on the agent card)</span></label>
        <input id={`${idp}-desc`} aria-label="What this agent does" name="description" maxLength={DESC_MAX} className={input} placeholder="e.g. Reviews pull requests for bugs and missing tests" value={description} onChange={(e) => setDescription(e.target.value)} />
        <p className="mt-1 text-right text-xs text-subtle" data-desc-count>{description.length} / {DESC_MAX}</p>
      </div>
      <div>
        <label htmlFor={`${idp}-prompt`} className={label}>Prompt / instructions <span className="text-danger">*</span> <span className="font-normal text-subtle">(what the agent is told to do on every run)</span></label>
        <textarea id={`${idp}-prompt`} aria-label="Prompt / instructions" name="prompt" required maxLength={PROMPT_MAX} className={`${input} h-64 resize-y font-mono`} placeholder={`Example: ${PROMPT_EXAMPLE}`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <p className={`mt-1 text-right text-xs ${prompt.length > PROMPT_MAX * 0.95 ? "text-warning" : "text-subtle"}`} data-prompt-count>{prompt.length.toLocaleString("en-US")} / {PROMPT_MAX.toLocaleString("en-US")} characters</p>
      </div>
      <div className="flex gap-2">
        <button className={button} disabled={!name.trim() || !prompt.trim()}>{initial ? "Save agent" : "Create agent"}</button>
        {initial && <button type="button" className={ghost} onClick={onDone}>Cancel</button>}
      </div>
      {initial && <p className="text-xs text-subtle">Changing the engine, model or prompt makes a new version: workflows that use this agent need approval again. Editing only the description does not.</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
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
    <form className="mt-2 space-y-2 rounded-md border border-border p-3" onSubmit={async (e) => {
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
        <input aria-label="Engine" className={`${input} text-muted`} value={`${ENGINE[agent.engine] ?? agent.engine} · ${agent.model ?? "default"}`} readOnly />
        <select aria-label="Mode" name="mode" className={input} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="simulated">Simulated (records only)</option><option value="real">Real (runs the agent)</option>
        </select>
      </div>
      <textarea aria-label="Extra instructions" name="instructions" className={`${input} h-20`} placeholder="Optional extra instructions (appended to the agent's prompt)" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      <div className="flex gap-2"><button className={button} disabled={busy}>{busy ? "Starting…" : "Start run"}</button><button type="button" className={ghost} onClick={onClose}>Cancel</button></div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </form>
  );
}

export function AgentManager({ agents, repos, models }: { agents: AgentView[]; repos: string[]; models: Record<string, string[]> }) {
  const [open, setOpen] = useState<{ name: string; kind: "run" | "edit" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border p-4"><h3 className="mb-1 text-sm font-medium">New agent</h3><p className="mb-3 text-xs text-subtle">Name it, pick the engine, say what it does, and write the prompt it runs with.</p><AgentForm repos={repos} models={models} onDone={() => {}} /></div>
      <h3 className="text-sm font-medium">Team agents ({agents.length})</h3>
      {agents.length === 0 ? <p className="text-sm text-subtle">No agents yet.</p> : (
        <ul className="divide-y divide-border">{agents.map((a) => (
          <li key={a.name} className="py-3" data-agent={a.name}>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-mono font-medium">{a.name}</span>
              {isEngine(a.engine) ? <Badge tone="blue">{ENGINE[a.engine]}</Badge> : <span data-unsupported-engine><Badge tone="gray">{a.engine}: {UNSUPPORTED_ENGINE}</Badge></span>}
              <span className="font-mono text-xs text-fg-soft" data-model>{a.model ?? "default model"}</span>
              <span className="font-mono text-xs text-subtle" title="version (sha256 of engine + prompt + model)">v {a.contentHash.slice(0, 12)}</span>
              {a.defaultRepo && <span className="font-mono text-xs text-muted">{a.defaultRepo}</span>}
              <span className="text-xs text-subtle" data-added-by>Added by {a.createdByEmail ?? "unknown"}{a.createdAt ? ` · ${new Date(a.createdAt).toLocaleDateString()}` : ""}</span>
              <span className="ml-auto flex gap-2">
                {isEngine(a.engine) ? <button className={button} onClick={() => setOpen({ name: a.name, kind: "run" })}>Run</button> : <button className={button} disabled title={UNSUPPORTED_ENGINE}>Run</button>}
                {a.canEdit && <button className={ghost} onClick={() => setOpen({ name: a.name, kind: "edit" })}>Edit</button>}
                {a.canEdit && <button className={danger} onClick={() => { setError(null); setConfirmDelete(a.name); }}>Delete</button>}
              </span>
            </div>
            {!a.canEdit && <p className="mt-1 text-xs text-subtle" data-run-only>You can run this agent. Only its creator ({a.createdByEmail ?? "unknown"}), team leads, the designated lead and admins can edit or delete it.</p>}
            {a.description ? <p className="mt-1 text-sm text-fg-soft" data-description>{a.description}</p> : <p className="mt-1 text-xs italic text-faint">No description</p>}
            <details className="mt-1" data-prompt-view open={a.prompt.length <= 300 || undefined}>
              <summary className="cursor-pointer text-xs text-muted hover:text-fg-soft">Prompt / instructions ({a.prompt.length.toLocaleString("en-US")} chars){a.canEdit ? "" : " · read-only"}</summary>
              <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-code p-2 font-mono text-xs text-code-fg">{a.prompt}</pre>
            </details>
            {open?.name === a.name && open.kind === "run" && <RunAgentForm agent={a} repos={repos} onClose={() => setOpen(null)} />}
            {open?.name === a.name && open.kind === "edit" && <div className="mt-2"><AgentForm initial={a} repos={repos} models={models} onDone={() => setOpen(null)} /></div>}
          </li>))}</ul>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {confirmDelete && (
        <div role="dialog" aria-modal="true" aria-labelledby="del-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setConfirmDelete(null)}>
          <div className="w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 id="del-title" className="text-base font-semibold">Delete agent <span className="font-mono">{confirmDelete}</span>?</h3>
            <p className="mt-2 text-sm text-fg-soft">It disappears from the Agents page and can&apos;t be run any more. Workflows that use it will fail validation until you pick another agent. Past runs and their logs are kept.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className={ghost} disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className={dangerSolid} disabled={busy} onClick={async () => {
                setBusy(true);
                const r = await call(`/api/agents/${encodeURIComponent(confirmDelete)}`, "DELETE");
                setBusy(false); setConfirmDelete(null);
                if (!r.ok) setError(r.data.error ?? "Failed"); else router.refresh();
              }}>{busy ? "Deleting…" : "Delete agent"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
