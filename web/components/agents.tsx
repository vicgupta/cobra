"use client";

// Team agents: list, create, edit, delete, and a Run form per agent. Scheduling lives in Tasks.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "./ui";
import { button, call, ConfirmDialog, danger, EmptyState, Field, ghost, input, nameProblem, Segmented, sentence, slug, td, th } from "./form-ui";
import { ENGINES, ENGINE_LABEL, isEngine, UNSUPPORTED_ENGINE } from "@/lib/engines";

// Mirrors AGENT_PROMPT_MAX / AGENT_DESCRIPTION_MAX in lib/agents.ts (server-only module).
const PROMPT_MAX = 20000, DESC_MAX = 500;
const PROMPT_EXAMPLE = "You are a careful code reviewer. Read the diff on the current branch, list bugs, risky changes and missing tests, then suggest concrete fixes. Do not push or merge.";
const ENGINE: Record<string, string> = ENGINE_LABEL;

export type AgentView = { name: string; engine: string; model: string | null; description: string | null; prompt: string; defaultRepo: string | null; skillRef?: string | null;
  cron?: string | null; cronMode?: "simulated" | "real"; contentHash: string; createdByEmail: string | null; createdAt?: number; canEdit: boolean };
/** A skill an agent can run: "sop:<id>" (a team skill). */
export type SkillOption = { ref: string; label: string; kind: "sop"; href?: string };


/** The engine's models (MVP build: Claude Code and Codex only). */
export function ModelPicker({ id, engine, models, value, onChange }: { id?: string; engine: string; models: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <select id={id} aria-label="Model" name="model" className={input} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Default model</option>
      {value && !models.includes(value) && <option value={value}>{value} (not available)</option>}
      <optgroup label={`${isEngine(engine) ? ENGINE_LABEL[engine] : engine} models`}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</optgroup>
    </select>
  );
}

function AgentForm({ initial, repos, models, skills, onDone }: { initial?: AgentView; repos: string[]; models: Record<string, string[]>; skills: SkillOption[]; onDone: () => void }) {
  const [kind, setKind] = useState<"prompt" | "skill">(initial?.skillRef ? "skill" : "prompt");
  const [skillRef, setSkillRef] = useState(initial?.skillRef ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [engine, setEngine] = useState(initial?.engine ?? "claude-code");
  const [model, setModel] = useState(initial?.model ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [repo, setRepo] = useState(initial?.defaultRepo ?? "");
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const idp = initial ? `agent-${initial.name}` : "agent-new";
  const nameErr = nameProblem(name) ?? (tried && !name ? "Give the agent a name" : null);
  const promptErr = tried && kind === "prompt" && !prompt.trim() ? "Write what the agent should do" : null;
  const skillErr = tried && kind === "skill" && !skillRef ? "Pick a skill" : null;
  const picked = skills.find((o) => o.ref === skillRef);
  return (
    <form className="space-y-5" noValidate onSubmit={async (e) => {
      e.preventDefault(); setTried(true);
      if (!name || nameProblem(name) || (kind === "prompt" ? !prompt.trim() : !skillRef)) return;
      setBusy(true);
      const body = { name, engine, model: model || null, description: description.trim() || null, kind, ...(kind === "prompt" ? { prompt, skillRef: null } : { skillRef }), defaultRepo: repo || null };
      const r = initial ? await call(`/api/agents/${encodeURIComponent(initial.name)}`, "PATCH", body) : await call("/api/agents", "POST", body);
      setBusy(false);
      if (!r.ok) return setError(sentence(r.data.error ?? "Couldn't save the agent"));
      setError(null); onDone(); router.refresh();
    }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idp}-name`} label="Name" error={nameErr} hint="Lowercase letters, numbers and dashes, e.g. reviewer">
          <input id={`${idp}-name`} name="name" autoFocus={!initial} className={input} placeholder="reviewer" value={name} aria-invalid={!!nameErr} onChange={(e) => setName(slug(e.target.value))} />
        </Field>
        <Field id={`${idp}-desc`} label="Description" optional>
          <input id={`${idp}-desc`} name="description" maxLength={DESC_MAX} className={input} placeholder="Reviews pull requests for bugs and missing tests" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <Segmented name={`${idp}-kind`} label="What it runs" value={kind} options={[["prompt", "Prompt"], ["skill", "Skill"]]} onChange={setKind} />
      {kind === "prompt" ? (
        <Field id={`${idp}-prompt`} label="Prompt" error={promptErr} hint={prompt.length > PROMPT_MAX * 0.9 ? `${prompt.length.toLocaleString("en-US")} / ${PROMPT_MAX.toLocaleString("en-US")} characters` : "What the agent is told to do on every run."}>
          <textarea id={`${idp}-prompt`} name="prompt" maxLength={PROMPT_MAX} className={`${input} h-48 resize-y`} placeholder={PROMPT_EXAMPLE} value={prompt} aria-invalid={!!promptErr} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
      ) : (
        <Field id={`${idp}-skill`} label="Skill" error={skillErr} hint={<>Manage skills in the <Link href="/agents/skills" className="underline">Skills</Link>.</>}>
          <select id={`${idp}-skill`} name="skillRef" className={input} value={skillRef} aria-invalid={!!skillErr} onChange={(e) => setSkillRef(e.target.value)}>
            <option value="">Pick a skill…</option>
            {skillRef && !picked && <option value={skillRef}>missing skill</option>}
            {skills.map((o) => <option key={o.ref} value={o.ref}>{o.label}</option>)}
          </select>
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id={`${idp}-engine`} label="Engine">
          <select id={`${idp}-engine`} name="engine" className={input} value={engine} onChange={(e) => { setEngine(e.target.value); setModel(""); }}>
            {ENGINES.map((e) => <option key={e} value={e}>{ENGINE_LABEL[e]}</option>)}
          </select>
        </Field>
        <Field id={`${idp}-model`} label="Model"><ModelPicker id={`${idp}-model`} key={engine} engine={engine} models={models[engine] ?? []} value={model} onChange={setModel} /></Field>
        <Field id={`${idp}-repo`} label="Default repo" optional>
          <select id={`${idp}-repo`} name="defaultRepo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">None</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button className={button} disabled={busy}>{busy ? "Saving…" : initial ? "Save changes" : "Create agent"}</button>
        <button type="button" className={ghost} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function RunAgentForm({ agent, repos, onClose }: { agent: AgentView; repos: string[]; onClose: () => void }) {
  const [repo, setRepo] = useState(agent.defaultRepo ?? "");
  const [mode, setMode] = useState<"simulated" | "real">("simulated");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const idp = `run-${agent.name}`;
  return (
    <form className="space-y-4 rounded-lg border border-border bg-bg p-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      const r = await call(`/api/agents/${encodeURIComponent(agent.name)}/runs`, "POST", { repo: repo || undefined, mode, instructions });
      setBusy(false);
      if (!r.ok || !r.data.id) return setError(sentence(r.data.error ?? "Couldn't start the run"));
      router.push(`/runs/${encodeURIComponent(r.data.id)}`);
    }}>
      <div className="flex flex-wrap items-end gap-4">
        <Segmented name={`${idp}-mode`} label="Run type" value={mode} options={[["simulated", "Test run"], ["real", "Real run"]]} onChange={setMode} />
        <div className="min-w-56 flex-1"><Field id={`${idp}-repo`} label="Repo">
          <select id={`${idp}-repo`} name="repo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">No repo</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select></Field></div>
      </div>
      <Field id={`${idp}-ins`} label="Extra instructions" optional>
        <textarea id={`${idp}-ins`} name="instructions" className={`${input} h-20`} placeholder="e.g. Only look at the auth module" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2"><button className={button} disabled={busy}>{busy ? "Starting…" : mode === "real" ? "Start real run" : "Start test run"}</button><button type="button" className={ghost} onClick={onClose}>Cancel</button></div>
    </form>
  );
}

export function AgentManager({ agents, repos, models, skills = [] }: { agents: AgentView[]; repos: string[]; models: Record<string, string[]>; skills?: SkillOption[] }) {
  const [open, setOpen] = useState<{ name: string; kind: "run" | "edit" } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const props = { repos, models, skills };
  if (creating) return <section className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm" aria-labelledby="new-agent-h"><h2 id="new-agent-h" className="mb-4 text-base font-semibold">New agent</h2><AgentForm {...props} onDone={() => setCreating(false)} /></section>;
  const editing = open?.kind === "edit" ? agents.find((a) => a.name === open.name) : undefined;
  if (editing) return <section className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm" aria-labelledby="edit-agent-h"><h2 id="edit-agent-h" className="mb-4 text-base font-semibold">Edit {editing.name}</h2><AgentForm {...props} initial={editing} onDone={() => setOpen(null)} /></section>;
  return (
    <div className="space-y-4">
      {agents.length === 0 ? <EmptyState title="No agents yet" body="An agent is a coding engine with a prompt or a skill. Your whole team can run it, and Tasks can run it on a schedule." action={<button className={button} onClick={() => setCreating(true)}>Create your first agent</button>} /> : <>
        <div className="flex items-center justify-between"><p className="text-sm text-subtle">{agents.length} {agents.length === 1 ? "agent" : "agents"}</p><button className={button} onClick={() => setCreating(true)}>New agent</button></div>
        <div className="overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-border"><tr><th scope="col" className={th}>Agent</th><th scope="col" className={th}>Runs</th><th scope="col" className={th}>Engine</th><th scope="col" className={th}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-border">{agents.map((a) => {
              const s = a.skillRef ? skills.find((o) => o.ref === a.skillRef) : undefined;
              return [
                <tr key={a.name} data-agent={a.name}>
                  <td className={td}><div className="font-medium text-fg">{a.name}</div>{a.description && <div className="max-w-md text-xs text-subtle" data-description>{a.description}</div>}</td>
                  <td className={td}>{a.skillRef ? <span data-agent-skill className="inline-flex items-center gap-2"><span className="text-fg-soft">{s?.label ?? "missing skill"}</span></span>
                    : <span data-agent-prompt className="text-fg-soft" title={a.prompt.slice(0, 400)}>Prompt</span>}</td>
                  <td className={td}>{isEngine(a.engine) ? <span className="text-fg-soft">{ENGINE[a.engine]}{a.model ? <span className="text-subtle"> · {a.model}</span> : null}</span> : <span data-unsupported-engine><Badge tone="gray">{a.engine}: {UNSUPPORTED_ENGINE}</Badge></span>}</td>
                  <td className={`${td} text-right`}><span className="inline-flex gap-1">
                    {isEngine(a.engine) ? <button className={button} aria-expanded={open?.name === a.name && open.kind === "run"} onClick={() => setOpen(open?.name === a.name && open.kind === "run" ? null : { name: a.name, kind: "run" })}>Run</button> : <button className={button} disabled title={UNSUPPORTED_ENGINE}>Run</button>}
                    {a.canEdit ? <button className={ghost} onClick={() => setOpen({ name: a.name, kind: "edit" })}>Edit</button> : <span className="px-2 py-1.5 text-xs text-subtle" title={`Only ${a.createdByEmail ?? "its creator"}, team leads and admins can edit it`} data-run-only>View only</span>}
                    {a.canEdit && <button className={danger} aria-label={`Delete ${a.name}`} onClick={() => { setError(null); setConfirmDelete(a.name); }}>Delete</button>}
                  </span></td>
                </tr>,
                open?.name === a.name && open.kind === "run" ? <tr key={`${a.name}-run`}><td colSpan={4} className="px-3 pb-4"><RunAgentForm agent={a} repos={repos} onClose={() => setOpen(null)} /></td></tr> : null,
              ];
            })}</tbody>
          </table>
        </div></>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {confirmDelete && <ConfirmDialog title={<>Delete {confirmDelete}?</>} confirm="Delete agent" busy={busy}
        body="It disappears from this list and can't be run any more, including by tasks that use it. Past runs are kept."
        onCancel={() => setConfirmDelete(null)} onConfirm={async () => {
          setBusy(true);
          const r = await call(`/api/agents/${encodeURIComponent(confirmDelete)}`, "DELETE");
          setBusy(false); setConfirmDelete(null);
          if (!r.ok) setError(sentence(r.data.error ?? "Couldn't delete the agent")); else router.refresh();
        }} />}
    </div>
  );
}
