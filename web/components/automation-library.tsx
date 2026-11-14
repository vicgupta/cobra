"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { button, call, ConfirmDialog, Field, ghost, input, nameProblem, Segmented, sentence, slug, Switch } from "./form-ui";
import { DAYS, describeCron, fromCron, PRESETS, scheduleProblem, toCron, type Preset, type Schedule } from "@/lib/schedule";
import type { LibraryPack } from "@/lib/automation-library";
import type { TaskAgentOption, TaskMember, NotifyOn } from "./tasks";

const RUN_TYPES: Array<["simulated" | "real", string]> = [["simulated", "Test run"], ["real", "Real run"]];
const NOTIFY_WHEN: Array<[NotifyOn, string]> = [["off", "Off"], ["success", "On success"], ["failure", "On failure"], ["both", "On success or failure"]];

export function AutomationLibrary({ packs, agents, repos, members, hasTeamEmail }: { packs: LibraryPack[]; agents: TaskAgentOption[]; repos: string[]; members: TaskMember[]; hasTeamEmail: boolean }) {
  const [open, setOpen] = useState<LibraryPack | null>(null);
  if (agents.length === 0 || repos.length === 0) {
    return (
      <section className="space-y-3" data-automation-library>
        <header><h2 className="text-base font-semibold tracking-tight">Automation library</h2>
          <p className="mt-1 text-sm text-muted">Ready-made engineering tasks you can edit and turn on. Create an agent and add a repo first.</p></header>
      </section>
    );
  }
  if (open) return <LibraryForm pack={open} agents={agents} repos={repos} members={members} hasTeamEmail={hasTeamEmail} onDone={() => setOpen(null)} />;
  return (
    <section className="space-y-3" data-automation-library>
      <header><h2 className="text-base font-semibold tracking-tight">Automation library</h2>
        <p className="mt-1 text-sm text-muted">One-click starting points. You pick the repo and agent, and you can edit the skill, schedule and delivery before turning one on.</p></header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {packs.map((p) => (
          <article key={p.key} data-pack={p.key} className="flex flex-col rounded-xl border border-border bg-surface/60 p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-fg">{p.title}</h3>
            <p className="mt-1 flex-1 text-sm text-muted">{p.summary}</p>
            <p className="mt-2 text-xs text-subtle">{p.scheduleLabel} · starts as a {p.mode === "real" ? "real" : "test"} run</p>
            <button type="button" className={`${button} mt-3 self-start`} onClick={() => setOpen(p)}>Use this</button>
          </article>
        ))}
      </div>
    </section>
  );
}

function LibraryForm({ pack, agents, repos, members, hasTeamEmail, onDone }: { pack: LibraryPack; agents: TaskAgentOption[]; repos: string[]; members: TaskMember[]; hasTeamEmail: boolean; onDone: () => void }) {
  const [skillName, setSkillName] = useState(pack.skillName);
  const [skillDescription, setSkillDescription] = useState(pack.skillDescription);
  const [skillBody, setSkillBody] = useState(pack.skillBody);
  const [taskName, setTaskName] = useState(pack.taskName);
  const [agent, setAgent] = useState(agents.length === 1 ? agents[0].name : "");
  const [repo, setRepo] = useState(repos.length === 1 ? repos[0] : "");
  const [sched, setSched] = useState<Schedule>(fromCron(pack.cron));
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<"simulated" | "real">(pack.mode);
  const [notifyOn, setNotifyOn] = useState<NotifyOn>(pack.notifyOn);
  const [notifyInApp, setNotifyInApp] = useState(pack.notifyInApp);
  const [notifyEmail, setNotifyEmail] = useState(!!hasTeamEmail && pack.notifyEmail);
  const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const cron = toCron(sched);
  const nameErr = nameProblem(skillName) ?? (tried && !skillName ? "Give the skill a name" : null);
  const taskErr = nameProblem(taskName) ?? (tried && !taskName ? "Give the task a name" : null);
  const agentErr = tried && !agent ? "Pick an agent" : null;
  const repoErr = tried && !repo ? "Pick a repo" : null;
  const schedErr = scheduleProblem(sched);
  const set = (p: Partial<Schedule>) => setSched((s) => ({ ...s, ...p }));
  const body = () => ({
    pack: pack.key, skillName, skillDescription, skillBody, taskName, agent, repo, cron, enabled: enabled && !!cron, mode,
    notifyOn, notifyInApp, notifyEmail: hasTeamEmail && notifyEmail, notifyEmails: hasTeamEmail && notifyEmail ? notifyEmails : [],
  });
  return (
    <section className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm" aria-labelledby="library-h" data-library-form={pack.key}>
      <h2 id="library-h" className="mb-1 text-base font-semibold">Set up {pack.title}</h2>
      <p className="mb-4 text-sm text-muted">Everything below is a starting point. Change whatever you want, then confirm to create the skill and the task.</p>
      <form className="space-y-5" noValidate onSubmit={(e) => { e.preventDefault(); setTried(true); if (nameErr || taskErr || !agent || !repo || schedErr) return; setConfirm(true); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="lib-task-name" label="Task name" error={taskErr} hint="Lowercase letters, numbers and dashes">
            <input id="lib-task-name" className={input} value={taskName} aria-invalid={!!taskErr} onChange={(e) => setTaskName(slug(e.target.value))} />
          </Field>
          <Field id="lib-skill-name" label="Skill name" error={nameErr}>
            <input id="lib-skill-name" className={input} value={skillName} aria-invalid={!!nameErr} onChange={(e) => setSkillName(slug(e.target.value))} />
          </Field>
          <Field id="lib-agent" label="Agent" error={agentErr}>
            <select id="lib-agent" className={input} value={agent} aria-invalid={!!agentErr} onChange={(e) => setAgent(e.target.value)}>
              <option value="">Pick an agent…</option>
              {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </Field>
          <Field id="lib-repo" label="Repo" error={repoErr}>
            <select id="lib-repo" className={input} value={repo} aria-invalid={!!repoErr} onChange={(e) => setRepo(e.target.value)}>
              <option value="">Pick a repo…</option>
              {repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <Field id="lib-desc" label="Skill description" optional>
          <input id="lib-desc" className={input} value={skillDescription} onChange={(e) => setSkillDescription(e.target.value)} />
        </Field>
        <Field id="lib-body" label="Skill instructions" hint="Plain language. Each ## heading becomes a step.">
          <textarea id="lib-body" className={`${input} min-h-40 font-mono text-sm`} value={skillBody} onChange={(e) => setSkillBody(e.target.value)} />
        </Field>
        <fieldset className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium text-fg-soft">Schedule</legend>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-52"><select aria-label="Schedule" className={input} value={sched.preset} onChange={(e) => set({ preset: e.target.value as Preset })}>
              {PRESETS.filter(([v]) => v !== "none").map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select></div>
            {sched.preset === "weekly" && <div className="w-40"><select aria-label="Day" className={input} value={sched.day} onChange={(e) => set({ day: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>}
            {(sched.preset === "daily" || sched.preset === "weekdays" || sched.preset === "weekly") && <div className="w-36"><input aria-label="Time" type="time" step={60} className={input} value={sched.time} onChange={(e) => set({ time: e.target.value })} /></div>}
            {sched.preset === "custom" && <div className="w-56"><input aria-label="Cron" className={`${input} font-mono`} value={sched.cron} onChange={(e) => set({ cron: e.target.value })} /></div>}
          </div>
          {schedErr ? <p className="text-xs text-danger">{schedErr}</p> : <p className="text-sm text-fg-soft">{describeCron(cron)}</p>}
          <label className="flex items-center gap-2 text-sm text-fg-soft"><Switch checked={enabled} onChange={setEnabled} label="Schedule on" /> {enabled ? "On — runs automatically after you confirm" : "Off — only runs when you click Run"}</label>
        </fieldset>
        <Segmented name="lib-mode" label="Run type" value={mode} options={RUN_TYPES} onChange={setMode} />
        <p className="-mt-3 text-xs text-subtle">{mode === "real" ? "Real runs use the agent for real and can comment or open pull requests if the skill says so." : "Test runs record what would happen without changing anything. You can switch to a real run later."}</p>
        <fieldset className="space-y-3 rounded-lg border border-border p-4" data-task-delivery>
          <legend className="px-1 text-sm font-medium text-fg-soft">When it finishes</legend>
          <Segmented name="lib-notify-on" label="Send a result" value={notifyOn} options={NOTIFY_WHEN} onChange={setNotifyOn} />
          {notifyOn !== "off" && <>
            <label className="flex items-center gap-2 text-sm text-fg-soft"><Switch checked={notifyInApp} onChange={setNotifyInApp} label="In-app notification" /> In-app notification (bell in the header)</label>
            <label className={`flex items-center gap-2 text-sm ${hasTeamEmail ? "text-fg-soft" : "text-subtle"}`}>
              <Switch checked={hasTeamEmail && notifyEmail} onChange={setNotifyEmail} label="Email" disabled={!hasTeamEmail} /> Email
            </label>
            {!hasTeamEmail && <p className="text-xs text-subtle">Set up a team mailbox in Settings → Email first.</p>}
            {hasTeamEmail && notifyEmail && <div className="space-y-1 pl-1">{members.map((m) => (
              <label key={m.email} className="flex items-center gap-2 text-sm text-fg-soft">
                <input type="checkbox" className="rounded border-border" checked={notifyEmails.includes(m.email)}
                  onChange={(e) => setNotifyEmails((cur) => e.target.checked ? [...cur, m.email] : cur.filter((x) => x !== m.email))} />
                {m.name ? `${m.name} (${m.email})` : m.email}
              </label>
            ))}</div>}
          </>}
        </fieldset>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          <button className={button} type="submit">Review and turn on</button>
          <button type="button" className={ghost} onClick={onDone}>Cancel</button>
        </div>
      </form>
      {confirm && <ConfirmDialog title={<>Turn on {pack.title}?</>} body={`This creates the skill “${skillName}” and the task “${taskName}” on ${describeCron(cron).replace(/^Runs /, "").replace(/^./, (c) => c.toLowerCase())}. You can edit or delete them later.`} confirm="Create skill and task" busy={busy}
        onCancel={() => setConfirm(false)} onConfirm={async () => {
          setBusy(true); setError(null);
          const r = await call("/api/automation-library", "POST", body());
          setBusy(false);
          if (!r.ok) { setConfirm(false); return setError(sentence(r.data.error ?? "Couldn't turn this on")); }
          setConfirm(false);
          const id = Number((r.data as { task?: { id?: unknown } }).task?.id);
          router.push(Number.isInteger(id) && id > 0 ? `/tasks?tab=current&task=${id}` : "/tasks");
        }} />}
    </section>
  );
}

