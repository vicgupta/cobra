"use client";

// Tasks: an agent (+ optional one skill) on a cron schedule with run criteria; list, create, edit, delete, Run now.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "./ui";

const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const ghost = "rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2 disabled:opacity-50";
const danger = "rounded-md border border-border-strong px-3 py-1.5 text-sm text-danger hover:bg-danger-soft disabled:opacity-50";
const label = "block text-sm font-medium text-fg-soft";
const CRON_EXAMPLES = "e.g. 0 9 * * 1-5 (9:00 AM weekdays) · */30 * * * * (every 30 min)";

/** A skill a task can run, shown by name only. */
export type TaskSkillOption = { ref: string; name: string; status: string };
export type TaskView = { id: number; name: string; agent: string; skillRef: string | null; cron: string | null; enabled: boolean; mode: "simulated" | "real";
  repo: string | null; instructions: string | null; createdByEmail: string | null; canEdit: boolean };

async function call(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, data: (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as { error?: string; id?: string } };
}

function TaskForm({ initial, agents, skills, repos, onDone }: { initial?: TaskView; agents: string[]; skills: TaskSkillOption[]; repos: string[]; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [agent, setAgent] = useState(initial?.agent ?? "");
  const [skillRef, setSkillRef] = useState(initial?.skillRef ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "");
  const [enabled, setEnabled] = useState(!!initial?.enabled);
  const [mode, setMode] = useState<"simulated" | "real">(initial?.mode ?? "simulated");
  const [repo, setRepo] = useState(initial?.repo ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <form className="space-y-3" data-task-form onSubmit={async (e) => {
      e.preventDefault();
      const body = { name, agent, skillRef: skillRef || null, cron: cron.trim() || null, enabled: enabled && !!cron.trim(), mode, repo: repo || null, instructions: instructions.trim() || null };
      const r = initial ? await call(`/api/tasks/${initial.id}`, "PATCH", body) : await call("/api/tasks", "POST", body);
      if (!r.ok) return setError(r.data.error ?? "Failed");
      setError(null);
      if (!initial) { setName(""); setAgent(""); setSkillRef(""); setCron(""); setEnabled(false); setMode("simulated"); setRepo(""); setInstructions(""); }
      onDone(); router.refresh();
    }}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input aria-label="Task name" name="name" className={input} placeholder="name (e.g. nightly-review)" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
        <select aria-label="Agent" name="agent" className={input} value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Pick an agent…</option>
          {agent && !agents.includes(agent) && <option value={agent}>{agent} (not found)</option>}
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select aria-label="Skill" name="skillRef" className={input} value={skillRef} onChange={(e) => setSkillRef(e.target.value)}>
          <option value="">No skill (use the agent&apos;s own prompt or skill)</option>
          {skillRef && !skills.some((o) => o.ref === skillRef) && <option value={skillRef}>skill not found</option>}
          {skills.map((o) => <option key={o.ref} value={o.ref}>{o.name}</option>)}
        </select>
      </div>
      {skillRef && skills.find((o) => o.ref === skillRef)?.status && <p className="text-xs text-subtle" data-skill-status>approval: {skills.find((o) => o.ref === skillRef)?.status}. Real runs of a SOP skill need it approved.</p>}
      <fieldset className="space-y-2 rounded-md border border-border p-3" data-task-schedule>
        <legend className="px-1 text-sm font-medium text-fg-soft">Schedule <span className="font-normal text-subtle">(cron, America/New_York)</span></legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input aria-label="Cron schedule" name="cron" className={`${input} font-mono`} placeholder="0 9 * * 1-5" value={cron} onChange={(e) => setCron(e.target.value)} />
          <select aria-label="Run mode" name="mode" className={input} value={mode} onChange={(e) => setMode(e.target.value as "simulated" | "real")}>
            <option value="simulated">Simulated (records only)</option><option value="real">Real (runs the agent)</option>
          </select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Enabled" name="enabled" checked={enabled} disabled={!cron.trim()} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
        </div>
        <p className="text-xs text-subtle">{CRON_EXAMPLES}. Off unless enabled.</p>
      </fieldset>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select aria-label="Target repo" name="repo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">Agent&apos;s default repo</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <textarea aria-label="Extra instructions" name="instructions" className={`${input} h-20 sm:col-span-2`} placeholder="Optional extra instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button className={button} disabled={!name.trim() || !agent}>{initial ? "Save task" : "Create task"}</button>
        {initial && <button type="button" className={ghost} onClick={onDone}>Cancel</button>}
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </form>
  );
}

export function TaskManager({ tasks, agents, skills, repos }: { tasks: TaskView[]; agents: string[]; skills: TaskSkillOption[]; repos: string[] }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const skillName = (ref: string | null) => (ref ? skills.find((o) => o.ref === ref)?.name ?? "skill not found" : null);
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border p-4"><h3 className="mb-1 text-sm font-medium">New task</h3>
        <p className="mb-3 text-xs text-subtle">Name it, pick an agent and optionally one skill, then set the schedule and run criteria. New tasks are disabled until you enable them.</p>
        {agents.length ? <TaskForm agents={agents} skills={skills} repos={repos} onDone={() => {}} /> : <p className="text-sm text-subtle">Create an agent first (Agents).</p>}</div>
      <h3 className="text-sm font-medium">Team tasks ({tasks.length})</h3>
      {tasks.length === 0 ? <p className="text-sm text-subtle">No tasks yet.</p> : (
        <ul className="divide-y divide-border">{tasks.map((t) => (
          <li key={t.id} className="py-3" data-task={t.name}>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-mono font-medium">{t.name}</span>
              <span className="text-xs text-fg-soft">agent: <span className="font-mono">{t.agent}</span></span>
              {t.skillRef ? <Badge tone="violet">skill: {skillName(t.skillRef)}</Badge> : <Badge tone="gray">agent default</Badge>}
              <span className="font-mono text-xs text-muted" title="America/New_York">{t.cron ?? "no schedule"}</span>
              <Badge tone={t.enabled ? "green" : "gray"}>{t.enabled ? "enabled" : "disabled"}</Badge>
              <span className="text-xs text-muted">{t.mode}</span>
              {t.repo && <span className="font-mono text-xs text-muted">{t.repo}</span>}
              <span className="ml-auto flex gap-2">
                <button className={button} disabled={busy === t.id} onClick={async () => {
                  setBusy(t.id); setMsg(null);
                  const r = await call(`/api/tasks/${t.id}/runs`, "POST", {});
                  setBusy(null);
                  if (!r.ok || !r.data.id) return setMsg(r.data.error ?? "Failed");
                  router.push(`/runs/${encodeURIComponent(r.data.id)}`);
                }}>{busy === t.id ? "Starting…" : "Run now"}</button>
                {t.canEdit && <button className={ghost} onClick={() => setEditing(editing === t.id ? null : t.id)}>Edit</button>}
                {t.canEdit && <button className={danger} onClick={async () => {
                  if (!window.confirm(`Delete task ${t.name}? Past runs are kept.`)) return;
                  const r = await call(`/api/tasks/${t.id}`, "DELETE");
                  if (!r.ok) return setMsg(r.data.error ?? "Failed");
                  router.refresh();
                }}>Delete</button>}
              </span>
            </div>
            {t.instructions && <p className="mt-1 whitespace-pre-wrap text-xs text-fg-soft">{t.instructions}</p>}
            {!t.canEdit && <p className="mt-1 text-xs text-subtle">You can run this task. Only its creator ({t.createdByEmail ?? "unknown"}), team leads, the designated lead and admins can edit or delete it.</p>}
            {editing === t.id && <div className="mt-2"><TaskForm initial={t} agents={agents} skills={skills} repos={repos} onDone={() => setEditing(null)} /></div>}
          </li>))}</ul>
      )}
      {msg && <p role="alert" className="text-sm text-danger">{msg}</p>}
    </div>
  );
}
