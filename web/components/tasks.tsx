"use client";

// Tasks: an agent (+ optional one skill) on a friendly schedule; list, create, edit, delete, Run now.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusPill } from "./recent-runs-table";
import { button, call, ConfirmDialog, danger, EmptyState, Field, ghost, input, nameProblem, Segmented, sentence, slug, Switch, td, th } from "./form-ui";
import { DAYS, describeCron, fromCron, PRESETS, scheduleProblem, toCron, type Preset, type Schedule } from "@/lib/schedule";
import { relativeTime } from "@/lib/runs-table";

/** A skill a task can run, shown by name. */
export type TaskSkillOption = { ref: string; name: string };
export type TaskAgentOption = { name: string; skillRef: string | null };
export type TaskView = { id: number; name: string; agent: string; skillRef: string | null; cron: string | null; enabled: boolean; mode: "simulated" | "real";
  repo: string | null; instructions: string | null; createdByEmail: string | null; canEdit: boolean; lastRun?: { id: string; status: string; startedAt: number } | null };

const RUN_TYPES: Array<["simulated" | "real", string]> = [["simulated", "Test run"], ["real", "Real run"]];
export const runTypeLabel = (m: string) => (m === "real" ? "Real run" : "Test run");

function TaskForm({ initial, agents, skills, repos, onDone }: { initial?: TaskView; agents: TaskAgentOption[]; skills: TaskSkillOption[]; repos: string[]; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [agent, setAgent] = useState(initial?.agent ?? (agents.length === 1 ? agents[0].name : ""));
  const [skillRef, setSkillRef] = useState(initial?.skillRef ?? "");
  const [sched, setSched] = useState<Schedule>(fromCron(initial?.cron));
  const [enabled, setEnabled] = useState(initial ? initial.enabled : false);
  const [mode, setMode] = useState<"simulated" | "real">(initial?.mode ?? "simulated");
  const [repo, setRepo] = useState(initial?.repo ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const idp = initial ? `task-${initial.id}` : "task-new";
  const cron = toCron(sched);
  const nameErr = nameProblem(name) ?? (tried && !name ? "Give the task a name" : null);
  const agentErr = tried && !agent ? "Pick an agent" : null;
  const schedErr = scheduleProblem(sched);
  const set = (p: Partial<Schedule>) => setSched((s) => ({ ...s, ...p }));
  return (
    <form className="space-y-5" data-task-form noValidate onSubmit={async (e) => {
      e.preventDefault(); setTried(true);
      if (!name || nameProblem(name) || !agent || schedErr) return;
      setBusy(true);
      const body = { name, agent, skillRef: skillRef || null, cron: cron || null, enabled: enabled && !!cron, mode, repo: repo || null, instructions: instructions.trim() || null };
      const r = initial ? await call(`/api/tasks/${initial.id}`, "PATCH", body) : await call("/api/tasks", "POST", body);
      setBusy(false);
      if (!r.ok) return setError(sentence(r.data.error ?? "Couldn't save the task"));
      setError(null); onDone(); router.refresh();
    }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idp}-name`} label="Name" error={nameErr} hint="Lowercase letters, numbers and dashes, e.g. nightly-review">
          <input id={`${idp}-name`} name="name" autoFocus={!initial} className={input} placeholder="nightly-review" value={name} aria-invalid={!!nameErr} onChange={(e) => setName(slug(e.target.value))} />
        </Field>
        <Field id={`${idp}-agent`} label="Agent" error={agentErr}>
          <select id={`${idp}-agent`} name="agent" className={input} value={agent} aria-invalid={!!agentErr} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Pick an agent…</option>
            {agent && !agents.some((a) => a.name === agent) && <option value={agent}>{agent} (missing)</option>}
            {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      <Field id={`${idp}-skill`} label="Skill" optional hint="Leave blank to run the agent as it's set up.">
        <select id={`${idp}-skill`} name="skillRef" className={input} value={skillRef} onChange={(e) => setSkillRef(e.target.value)}>
          <option value="">Use the agent&apos;s own setup</option>
          {skillRef && !skills.some((o) => o.ref === skillRef) && <option value={skillRef}>missing skill</option>}
          {skills.map((o) => <option key={o.ref} value={o.ref}>{o.name}</option>)}
        </select>
      </Field>
      <fieldset className="space-y-3 rounded-lg border border-border p-4" data-task-schedule>
        <legend className="px-1 text-sm font-medium text-fg-soft">Schedule</legend>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-52"><label htmlFor={`${idp}-preset`} className="sr-only">Schedule</label>
            <select id={`${idp}-preset`} aria-label="Schedule" name="preset" className={input} value={sched.preset} onChange={(e) => { const p = e.target.value as Preset; set({ preset: p, cron: p === "custom" ? cron || sched.cron : sched.cron }); if (p !== "none" && !initial?.cron) setEnabled(true); if (p === "none") setEnabled(false); }}>
              {PRESETS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select></div>
          {sched.preset === "weekly" && <div className="w-40"><label htmlFor={`${idp}-day`} className="sr-only">Day</label>
            <select id={`${idp}-day`} aria-label="Day" className={input} value={sched.day} onChange={(e) => set({ day: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>}
          {(sched.preset === "daily" || sched.preset === "weekdays" || sched.preset === "weekly") && <div className="w-36"><label htmlFor={`${idp}-time`} className="sr-only">Time</label>
            <input id={`${idp}-time`} aria-label="Time" type="time" step={60} className={input} value={sched.time} onChange={(e) => set({ time: e.target.value })} /></div>}
          {sched.preset === "hourly" && <div className="flex items-center gap-2 text-sm text-fg-soft"><label htmlFor={`${idp}-minute`}>at minute</label>
            <input id={`${idp}-minute`} type="number" min={0} max={59} className={`${input} w-20`} value={sched.minute} onChange={(e) => set({ minute: Number(e.target.value) })} /></div>}
          {sched.preset === "custom" && <div className="w-56"><label htmlFor={`${idp}-cron`} className="sr-only">Cron</label>
            <input id={`${idp}-cron`} aria-label="Cron" className={`${input} font-mono`} placeholder="0 9 * * 1-5" value={sched.cron} aria-invalid={!!schedErr} onChange={(e) => set({ cron: e.target.value })} /></div>}
        </div>
        {schedErr ? <p className="text-xs text-danger" data-field-error>{schedErr}</p>
          : <p className="text-sm text-fg-soft" data-schedule-preview aria-live="polite">{describeCron(cron)}{sched.preset === "custom" && <span className="text-subtle"> · minute hour day month weekday, Eastern time</span>}</p>}
        {sched.preset !== "none" && <label className="flex items-center gap-2 text-sm text-fg-soft"><Switch checked={enabled} onChange={setEnabled} label="Schedule on" /> {enabled ? "On — runs automatically" : "Off — only runs when you click Run now"}</label>}
      </fieldset>
      <Segmented name={`${idp}-mode`} label="Run type" value={mode} options={RUN_TYPES} onChange={setMode} />
      <p className="-mt-3 text-xs text-subtle">{mode === "real" ? "Real runs use the agent for real and can push branches and open pull requests." : "Test runs record what would happen without changing anything."}</p>
      <details className="rounded-lg border border-border px-4 py-3" open={!!(initial?.repo || initial?.instructions) || undefined}>
        <summary className="cursor-pointer text-sm font-medium text-fg-soft">More options</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field id={`${idp}-repo`} label="Repo" optional>
            <select id={`${idp}-repo`} name="repo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">Agent&apos;s default</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field id={`${idp}-ins`} label="Extra instructions" optional>
            <textarea id={`${idp}-ins`} name="instructions" className={`${input} h-20`} placeholder="e.g. Focus on security issues" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </Field>
        </div>
      </details>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button className={button} disabled={busy}>{busy ? "Saving…" : initial ? "Save changes" : "Create task"}</button>
        <button type="button" className={ghost} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function TaskManager({ tasks, agents, skills, repos, now }: { tasks: TaskView[]; agents: TaskAgentOption[]; skills: TaskSkillOption[]; repos: string[]; now: number }) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<TaskView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();
  const skillName = (ref: string | null) => (ref ? skills.find((o) => o.ref === ref)?.name ?? "missing skill" : null);
  const runs = (t: TaskView) => {
    const s = skillName(t.skillRef) ?? skillName(agents.find((a) => a.name === t.agent)?.skillRef ?? null);
    return <><span className="font-medium text-fg">{t.agent}</span>{s ? <span className="text-subtle"> · {s}</span> : <span className="text-subtle"> · prompt</span>}</>;
  };
  const props = { agents, skills, repos };
  if (!agents.length) return <EmptyState title="Create an agent first" body="A task runs one of your agents on a schedule or when you click Run now." action={<Link href="/agents" className={button}>Go to Agents</Link>} />;
  if (editing === "new") return <section className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm" aria-labelledby="new-task-h"><h2 id="new-task-h" className="mb-4 text-base font-semibold">New task</h2><TaskForm {...props} onDone={() => setEditing(null)} /></section>;
  const editingTask = tasks.find((t) => t.id === editing);
  if (editingTask) return <section className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm" aria-labelledby="edit-task-h" data-task={editingTask.name}><h2 id="edit-task-h" className="mb-4 text-base font-semibold">Edit {editingTask.name}</h2><TaskForm {...props} initial={editingTask} onDone={() => setEditing(null)} /></section>;
  return (
    <div className="space-y-4">
      {tasks.length === 0 ? <EmptyState title="No tasks yet" body="A task runs an agent on a schedule, like every weekday morning, or whenever you click Run now." action={<button className={button} onClick={() => setEditing("new")}>Create your first task</button>} /> : <>
        <div className="flex items-center justify-between"><p className="text-sm text-subtle">{tasks.length} {tasks.length === 1 ? "task" : "tasks"}</p><button className={button} onClick={() => setEditing("new")}>New task</button></div>
        <div className="overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-border"><tr><th scope="col" className={th}>Task</th><th scope="col" className={th}>Runs</th><th scope="col" className={th}>Schedule</th><th scope="col" className={th}>On</th><th scope="col" className={th}>Last run</th><th scope="col" className={th}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-border">{tasks.map((t) => (
              <tr key={t.id} data-task={t.name}>
                <td className={td}><div className="font-medium text-fg">{t.name}</div><div className="text-xs text-subtle">{runTypeLabel(t.mode)}{t.repo ? ` · ${t.repo}` : ""}</div></td>
                <td className={td}>{runs(t)}</td>
                <td className={`${td} text-fg-soft`} data-schedule>{t.cron ? describeCron(t.cron).replace(/^Runs /, "").replace(/^./, (c) => c.toUpperCase()) : <span className="text-subtle">Manual only</span>}</td>
                <td className={td}><Switch checked={t.enabled} label={`Schedule for ${t.name}`} disabled={!t.canEdit || !t.cron || busy === t.id}
                  title={!t.cron ? "Add a schedule first" : !t.canEdit ? "Only the creator, team leads and admins can change this" : undefined}
                  onChange={async (v) => { setBusy(t.id); setMsg(null); const r = await call(`/api/tasks/${t.id}`, "PATCH", { enabled: v }); setBusy(null); if (!r.ok) setMsg(sentence(r.data.error ?? "Couldn't update the task")); router.refresh(); }} /></td>
                <td className={td}>{t.lastRun ? <Link href={`/runs/${encodeURIComponent(t.lastRun.id)}`} className="inline-flex items-center gap-2 hover:underline"><StatusPill status={t.lastRun.status} /><span className="text-xs text-subtle">{relativeTime(t.lastRun.startedAt, now)}</span></Link> : <span className="text-xs text-subtle">Never</span>}</td>
                <td className={`${td} text-right`}><span className="inline-flex gap-1">
                  <button className={button} disabled={busy === t.id} onClick={async () => {
                    setBusy(t.id); setMsg(null);
                    const r = await call(`/api/tasks/${t.id}/runs`, "POST", {});
                    setBusy(null);
                    if (!r.ok || !r.data.id) return setMsg(sentence(r.data.error ?? "Couldn't start the run"));
                    router.push(`/runs/${encodeURIComponent(r.data.id)}`);
                  }}>{busy === t.id ? "Starting…" : "Run now"}</button>
                  {t.canEdit && <button className={ghost} onClick={() => setEditing(t.id)}>Edit</button>}
                  {t.canEdit && <button className={danger} aria-label={`Delete ${t.name}`} onClick={() => setConfirm(t)}>Delete</button>}
                </span></td>
              </tr>))}</tbody>
          </table>
        </div></>}
      {msg && <p role="alert" className="text-sm text-danger">{msg}</p>}
      {confirm && <ConfirmDialog title={<>Delete {confirm.name}?</>} body="It stops running and disappears from this list. Its past runs are kept." confirm="Delete task" busy={deleting}
        onCancel={() => setConfirm(null)} onConfirm={async () => {
          setDeleting(true); const r = await call(`/api/tasks/${confirm.id}`, "DELETE"); setDeleting(false); setConfirm(null);
          if (!r.ok) setMsg(sentence(r.data.error ?? "Couldn't delete the task")); else router.refresh();
        }} />}
    </div>
  );
}
