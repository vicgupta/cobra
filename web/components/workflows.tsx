"use client";

// Workflow UI pieces. Editing is plain YAML in a textarea, validated on the server.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, type Tone } from "./ui";
import { ENGINES, ENGINE_LABEL, engineLabel } from "@/lib/engines";
import { collapseSteps } from "@/lib/workflows/step-log";

const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const ghost = "rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2 disabled:opacity-50";

const STATUS_TONE: Record<string, Tone> = { approved: "green", pending: "amber", rejected: "red", running: "blue", succeeded: "green", failed: "red", cancelled: "amber", skipped: "gray" };
export function StatusBadge({ status }: { status: string | null | undefined }) {
  return <Badge tone={STATUS_TONE[status ?? ""] ?? "gray"} dot>{status ?? "unknown"}</Badge>;
}

async function send(url: string, body: unknown): Promise<{ ok: boolean; data: { error?: string; errors?: string[]; [k: string]: unknown } }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({ error: `HTTP ${r.status}` })) };
}

function Errors({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <ul role="alert" className="space-y-1 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 font-mono text-xs text-danger">
      {errors.map((e, i) => <li key={i}>{e}</li>)}
    </ul>
  );
}

export function CopyButton({ text, label = "Copy YAML" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={ghost} onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
      {done ? "Copied" : label}
    </button>
  );
}

export type StorageInit = { kind: string; repo?: string; path?: string; branch?: string };

/** Create (no previousName) or edit a tenant workflow/template. Storage: Cobra database or a YAML file in a GitHub repo. */
export function YamlEditor({ initial, previousName, templateName, storage: st, repos = [] }: { initial: string; previousName?: string; templateName?: string; storage?: StorageInit; repos?: string[] }) {
  const [source, setSource] = useState(initial);
  const [storage, setStorage] = useState<"database" | "github">(st?.kind === "github" ? "github" : "database");
  const [gh, setGh] = useState({ repo: st?.repo ?? "", path: st?.path ?? "", branch: st?.branch ?? "" });
  const [importing, setImporting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function save() {
    setBusy(true);
    const { ok, data } = await send("/api/workflows", { source, previousName, templateName, storage, github: storage === "github" ? gh : null, import: storage === "github" && importing });
    setBusy(false);
    if (!ok) return setErrors(data.errors ?? [data.error ?? "Save failed"]);
    setErrors([]);
    router.push(`/workflows/${encodeURIComponent(String(data.name))}`);
    router.refresh();
  }
  return (
    <div className="space-y-3">
      <fieldset className="space-y-2 rounded-md border border-border p-3 text-sm">
        <legend className="px-1 text-xs text-muted">Storage</legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-2"><input type="radio" name="storage" checked={storage === "database"} onChange={() => setStorage("database")} /> Cobra database</label>
          <label className="flex items-center gap-2"><input type="radio" name="storage" checked={storage === "github"} onChange={() => setStorage("github")} /> GitHub repo file</label>
        </div>
        {storage === "github" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <select aria-label="GitHub repo" className={input} value={gh.repo} onChange={(e) => setGh({ ...gh, repo: e.target.value })}>
              <option value="">{repos.length ? "Choose a team repo…" : "No repos registered (see Repos)"}</option>
              {[...repos, ...(gh.repo && !repos.includes(gh.repo) ? [gh.repo] : [])].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input aria-label="File path" className={input} placeholder=".cobra/workflows/my-workflow.yaml" value={gh.path} onChange={(e) => setGh({ ...gh, path: e.target.value })} />
            <input aria-label="Branch" className={input} placeholder="branch (default branch if empty)" value={gh.branch} onChange={(e) => setGh({ ...gh, branch: e.target.value })} />
            {!previousName && <label className="flex items-center gap-2 text-xs text-muted sm:col-span-3"><input type="checkbox" checked={importing} onChange={(e) => setImporting(e.target.checked)} /> Import the existing file instead of the YAML below</label>}
            <p className="text-xs text-subtle sm:col-span-3">Only your team&apos;s registered repos (<Link className="text-success hover:underline" href="/settings/repos">Repos</Link>). Read and written with the server&apos;s GITHUB_TOKEN. Saving commits the file.</p>
          </div>
        )}
      </fieldset>
      {!(storage === "github" && importing) && <textarea aria-label="Workflow YAML" className={`${input} min-h-[28rem] bg-code font-mono text-code-fg text-xs leading-5`} spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} />}
      <Errors errors={errors} />
      <div className="flex items-center gap-3">
        <button className={button} disabled={busy || (!source.trim() && !importing)} onClick={save}>{busy ? "Validating…" : previousName ? "Save changes" : importing ? "Import" : "Create"}</button>
        <p className="text-xs text-subtle">Validated on the server. Saving new content resets approval: approvers must approve this exact version before it can run.</p>
      </div>
    </div>
  );
}

export function SyncButton({ name }: { name: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="flex items-center gap-2">
      <button className={ghost} onClick={async () => {
        const { ok, data } = await send(`/api/workflows/${encodeURIComponent(name)}/sync`, {});
        setMsg(ok ? (data.changed ? "Updated from GitHub (needs approval)" : "Already up to date") : String(data.error));
        router.refresh();
      }}>Sync from GitHub</button>
      {msg && <span className="text-xs text-muted">{msg}</span>}
    </span>
  );
}

export function ApprovalPanel({ name, hash }: { name: string; hash: string }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    const { ok, data } = await send(`/api/workflows/${encodeURIComponent(name)}/approval`, { decision, comment });
    setBusy(false);
    if (!ok) return setError(data.error ?? "Failed");
    setError(null); setComment(""); router.refresh();
  }
  return (
    <div className="space-y-2">
      <textarea aria-label="Comment" className={`${input} h-20`} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button className={button} disabled={busy} onClick={() => decide("approve")}>Approve</button>
        <button className={`${ghost} border-rose-500/40 text-danger`} disabled={busy} onClick={() => decide("reject")}>Reject</button>
        <span className="font-mono text-xs text-subtle">version {hash.slice(0, 12)}</span>
      </div>
    </div>
  );
}

export type InputDef = { type: "string" | "number" | "boolean" | "choice"; description?: string; required?: boolean; default?: string | number | boolean; options?: string[] };

export type RunFlow = { engine: string; prompt: string | null; repo: string | null; repos: string[] };

/** Run flow: repo → engine → prompt (workflow template or free-form) → mode → inputs → Run. */
export function RunForm({ name, inputs, enabled, reason, flow: flowProp, hasAgentStep = false }: { name: string; inputs: Record<string, InputDef>; enabled: boolean; reason?: string; flow?: RunFlow; hasAgentStep?: boolean }) {
  // Repo, engine, mode and prompt only apply to workflows with a `uses: agent` step.
  const flow = hasAgentStep ? flowProp : undefined;
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(Object.entries(inputs).map(([k, d]) => [k, d.type === "boolean" ? Boolean(d.default) : d.default === undefined ? "" : String(d.default)])));
  const [repo, setRepo] = useState(flow?.repo ?? "");
  const [engine, setEngine] = useState(flow?.engine ?? "claude-code");
  const [promptMode, setPromptMode] = useState<"workflow" | "custom">(flow?.prompt ? "workflow" : "custom");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"simulated" | "real">("simulated");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
    const extra = flow ? { engine, mode, repo: repo || undefined, ...(promptMode === "custom" ? (prompt.trim() ? { promptMode, prompt } : { promptMode: "none" }) : { promptMode }) } : {};
    const { ok, data } = await send(`/api/workflows/${encodeURIComponent(name)}/runs`, { inputs: payload, ...extra });
    setBusy(false);
    if (!ok) return setErrors(data.errors ?? [data.error ?? "Run failed"]);
    router.push(`/runs/${data.id}`);
  }
  const flowFields = flow && (
    <div className="space-y-3 rounded-md border border-border p-3">
      <label className="block text-sm"><span className="text-fg-soft">Repo</span>
        <select aria-label="Repo" className={`${input} mt-1`} value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">— none (scratch workspace) —</option>
          {flow.repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select></label>
      <label className="block text-sm"><span className="text-fg-soft">Engine</span> <span className="ml-2 text-xs text-subtle">workflow default: {flow.engine}</span>
        <select aria-label="Engine" className={`${input} mt-1`} value={engine} onChange={(e) => setEngine(e.target.value)}>
          {ENGINES.map((e) => <option key={e} value={e}>{ENGINE_LABEL[e]}</option>)}
        </select></label>
      <fieldset className="text-sm"><legend className="text-fg-soft">Prompt</legend>
        <div className="mt-1 flex gap-4">
          <label className="flex items-center gap-2"><input type="radio" name="promptMode" disabled={!flow.prompt} checked={promptMode === "workflow"} onChange={() => setPromptMode("workflow")} /> Workflow prompt</label>
          <label className="flex items-center gap-2"><input type="radio" name="promptMode" checked={promptMode === "custom"} onChange={() => setPromptMode("custom")} /> Free-form</label>
        </div>
        {promptMode === "workflow" && flow.prompt && <pre className="mt-2 whitespace-pre-wrap rounded-md bg-code p-2 font-mono text-xs text-code-fg">{flow.prompt}</pre>}
        {promptMode === "custom" && <textarea aria-label="Prompt" className={`${input} mt-2 h-24`} maxLength={20000} placeholder="What should the agent do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />}
      </fieldset>
      <label className="block text-sm"><span className="text-fg-soft">Mode</span>
        <select aria-label="Mode" className={`${input} mt-1`} value={mode} onChange={(e) => setMode(e.target.value as "simulated" | "real")}>
          <option value="simulated">Simulated (records only, executes nothing)</option><option value="real">Real (local runner)</option>
        </select></label>
    </div>
  );
  return (
    <form onSubmit={run} className="space-y-3">
      {flowFields}
      {Object.entries(inputs).map(([k, d]) => (
        <label key={k} className="block text-sm">
          <span className="text-fg-soft">{k}{d.required && <span className="text-danger"> *</span>}</span>
          {d.description && <span className="ml-2 text-xs text-subtle">{d.description}</span>}
          <div className="mt-1">
            {d.type === "boolean" ? (
              <input type="checkbox" checked={Boolean(values[k])} onChange={(e) => setValues({ ...values, [k]: e.target.checked })} />
            ) : d.type === "choice" ? (
              <select className={input} value={String(values[k])} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                {!d.required && <option value="">—</option>}
                {d.options?.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <input className={input} type={d.type === "number" ? "number" : "text"} required={d.required} value={String(values[k])} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
            )}
          </div>
        </label>
      ))}
      <Errors errors={errors} />
      <button className={button} disabled={!enabled || busy}>{busy ? "Starting…" : "Run"}</button>
      {!enabled && reason && <p className="text-xs text-subtle">{reason}</p>}
    </form>
  );
}

type Event = { stepId: string; status: string; attempt: number; output: string | null; truncated: boolean; at: number };
type Detail = { id: string; workflow: string | null; workflowHash: string | null; status: string | null; error: string | null; startedAt: number; endedAt: number | null; outputs: Record<string, unknown> | null; events: Event[];
  engine?: string | null; promptSource?: string | null; prompt?: string | null; mode?: string | null; repo?: string | null; branch?: string | null };

function downloadLog(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read-only run log; polls while the run is still going. */
export function RunLog({ initial }: { initial: Detail }) {
  const [run, setRun] = useState(initial);
  useEffect(() => {
    if (run.status !== "running") return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/runs/${encodeURIComponent(run.id)}`);
      if (r.ok) setRun(await r.json());
    }, 1000);
    return () => clearInterval(t);
  }, [run.id, run.status]);
  const t = (ms: number) => new Date(ms).toLocaleTimeString();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <StatusBadge status={run.status} />
        {run.workflow && (run.workflow.startsWith("agent:")
          ? <Link className="text-success hover:underline" href="/agents">{run.workflow}</Link>
          : <span className="text-success">{run.workflow}</span>)}
        <span className="font-mono text-xs text-subtle">version {run.workflowHash?.slice(0, 12)}</span>
        <span className="text-xs text-subtle">started {new Date(run.startedAt).toLocaleString()}{run.endedAt ? ` · ended ${t(run.endedAt)}` : ""}</span>
      </div>
      {run.engine && (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1 rounded-md border border-border bg-bg p-3 text-sm">
          <dt className="text-subtle">Engine</dt><dd>{engineLabel(run.engine)}</dd>
          <dt className="text-subtle">Mode</dt><dd>{run.mode ?? "—"}</dd>
          <dt className="text-subtle">Repo</dt><dd className="font-mono text-xs">{run.repo || "—"}{run.branch ? ` → ${run.branch}` : ""}</dd>
          <dt className="text-subtle">Prompt</dt><dd><span className="text-xs text-subtle">{run.promptSource === "workflow" ? "workflow prompt" : run.promptSource === "custom" ? "free-form" : run.promptSource === "agent" ? "team agent prompt" : "none"}</span>
            {run.prompt && <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-fg-soft">{run.prompt}</pre>}</dd>
        </dl>
      )}
      {run.error && <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-danger">{run.error}</p>}
      <ol className="space-y-2">
        {collapseSteps(run.events).map((e) => (
          <li key={e.stepId} data-step={e.stepId} className="rounded-md border border-border bg-bg p-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-mono text-subtle">{t(e.startedAt)}{e.at !== e.startedAt ? ` → ${t(e.at)}` : ""}</span>
              <span className="font-mono text-fg-soft">{e.stepId}</span>
              <StatusBadge status={e.status} />
              {e.attempt > 1 && <span className="text-subtle">attempt {e.attempt}</span>}
              {e.output && <button type="button" className="ml-auto text-subtle hover:text-fg hover:underline" onClick={() => downloadLog(`${run.id}-${e.stepId}.log`, e.output!)}>Download log</button>}
            </div>
            {e.output && <pre className="mt-2 max-h-[36rem] resize-y overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-fg-soft">{e.output}</pre>}
            {e.truncated && <p className="mt-1 text-xs text-warning">Output was longer than the log limit; the middle was omitted (see the “truncated” marker).</p>}
          </li>
        ))}
      </ol>
      {run.outputs && Object.keys(run.outputs).length > 0 && (
        <pre className="overflow-auto rounded-md border border-border bg-code p-3 font-mono text-xs text-code-fg">{JSON.stringify(run.outputs, null, 2)}</pre>
      )}
    </div>
  );
}

/** Pick a template and one of the team's repos; creates a workflow instance attached to that repo. */
export function AttachTemplate({ templates, repos }: { templates: string[]; repos: string[] }) {
  const [template, setTemplate] = useState(templates[0] ?? "");
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  if (!templates.length) return <p className="text-sm text-subtle">No templates yet.</p>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select aria-label="Template" className={input} value={template} onChange={(e) => setTemplate(e.target.value)}>{templates.map((t) => <option key={t}>{t}</option>)}</select>
        <select aria-label="Template repo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
          {!repos.length && <option value="">No repos registered</option>}{repos.map((r) => <option key={r}>{r}</option>)}</select>
        <button className={button} disabled={busy || !template || !repo} onClick={async () => {
          setBusy(true);
          const { ok, data } = await send(`/api/templates/${encodeURIComponent(template)}/attach`, { repo });
          setBusy(false);
          if (!ok) return setErrors(data.errors ?? [data.error ?? "Failed"]);
          router.push(`/workflows/${encodeURIComponent(String(data.name))}`);
        }}>{busy ? "Creating…" : "Create from template"}</button>
      </div>
      <Errors errors={errors} />
    </div>
  );
}

type RepoRow = { repo: string; defaultBranch: string | null; patSet: boolean; patLast4: string | null; createdByEmail?: string | null; canEdit?: boolean };
const pushNote = (p: unknown) => (p === true ? "Token saved; it has push access." : p === false ? "Token saved, but it has no push access (read-only): agent runs can't push." : "Token saved.");

/** Job 8: canAdd = any team member; row.canEdit = creator, team lead, designated lead or admin (branch, remove);
 *  canManage = admin/team lead (every repo). Any member adds (token optional) and manages the repos they added (r.canEdit). */
export function RepoManager({ initial, canManage, canAdd = canManage }: { initial: RepoRow[]; canManage: boolean; canAdd?: boolean }) {
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [pat, setPat] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [newPat, setNewPat] = useState("");
  const [editBranch, setEditBranch] = useState<string | null>(null);
  const [branchVal, setBranchVal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  const patch = async (r: string, value: string | null) => {
    const res = await fetch("/api/repos", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: r, pat: value }) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; pushAccess?: boolean | null };
    if (!res.ok) { setNotice(null); return setError(data.error ?? "Failed"); }
    setError(null); setNotice(value === null ? `Token cleared for ${r}; it uses the server GITHUB_TOKEN.` : pushNote(data.pushAccess)); setEditing(null); setNewPat(""); router.refresh();
  };
  const saveBranch = async (r: string) => {
    const res = await fetch("/api/repos", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: r, defaultBranch: branchVal.trim() || null }) });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) { setNotice(null); return setError(data.error ?? "Failed"); }
    setError(null); setNotice(`Default branch updated for ${r}.`); setEditBranch(null); router.refresh();
  };
  return (
    <div className="space-y-3">
      {initial.length === 0 ? <p className="text-sm text-subtle">No repos registered yet.</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-subtle"><th className="py-1 font-normal">Repo</th><th className="py-1 font-normal">Added by</th><th className="py-1 font-normal">Branch</th><th className="py-1 font-normal">Personal access token</th><th /></tr></thead>
          <tbody className="divide-y divide-border">{initial.map((r) => (
            <tr key={r.repo}>
              <td className="py-2 font-mono">{r.repo}</td>
              <td className="py-2 text-xs text-subtle">{r.createdByEmail ?? "—"}</td>
              <td className="py-2 text-xs text-subtle">{editBranch === r.repo ? (
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void saveBranch(r.repo); }}>
                  <input aria-label={`Default branch for ${r.repo}`} className={`${input} py-1 text-xs`} placeholder="repo default" value={branchVal} onChange={(e) => setBranchVal(e.target.value)} />
                  <button className={`${button} py-1 text-xs`}>Save</button>
                  <button type="button" className={`${ghost} text-xs`} onClick={() => setEditBranch(null)}>Cancel</button>
                </form>
              ) : r.defaultBranch ? `default branch ${r.defaultBranch}` : "repo default branch"}</td>
              <td className="py-2 text-xs">
                {editing === r.repo ? (
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newPat.trim()) void patch(r.repo, newPat); }}>
                    <input type="password" autoComplete="off" aria-label={`New token for ${r.repo}`} className={`${input} py-1 text-xs`} placeholder="new token" value={newPat} onChange={(e) => setNewPat(e.target.value)} />
                    <button className={`${button} py-1 text-xs`} disabled={!newPat.trim()}>Save</button>
                    <button type="button" className={`${ghost} text-xs`} onClick={() => { setEditing(null); setNewPat(""); }}>Cancel</button>
                  </form>
                ) : <span data-pat-status={r.patSet ? "set" : "none"} className={r.patSet ? "font-mono text-success" : "text-subtle"}>{r.patSet ? `Set ••••${r.patLast4 ?? ""}` : "—"}</span>}
              </td>
              <td className="py-2 text-right">{editing !== r.repo && editBranch !== r.repo && (canManage || r.canEdit) && (
                <span className="inline-flex gap-2">
                  {(r.canEdit ?? canManage) && <button className={`${ghost} text-xs`} onClick={() => { setEditing(r.repo); setNewPat(""); }}>{r.patSet ? "Replace token" : "Set token"}</button>}
                  {(r.canEdit ?? canManage) && r.patSet && <button className={`${ghost} text-xs`} onClick={() => void patch(r.repo, null)}>Clear token</button>}
                  {(r.canEdit ?? canManage) && <button className={`${ghost} text-xs`} onClick={() => { setEditBranch(r.repo); setBranchVal(r.defaultBranch ?? ""); }}>Edit branch</button>}
                  {(r.canEdit ?? canManage) && <button className={`${ghost} text-xs`} onClick={async () => {
                    const res = await fetch(`/api/repos?repo=${encodeURIComponent(r.repo)}`, { method: "DELETE" });
                    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Failed"); else router.refresh();
                  }}>Remove</button>}
                </span>)}</td>
            </tr>))}</tbody>
        </table>
      )}
      {canAdd ? (
        <form className="grid grid-cols-1 gap-2 sm:grid-cols-4" onSubmit={async (e) => {
          e.preventDefault();
          const { ok, data } = await send("/api/repos", { repo, defaultBranch: branch || undefined, pat: pat || undefined });
          if (!ok) { setNotice(null); return setError(data.error ?? "Failed"); }
          setError(null); setNotice(pat ? pushNote((data as { pushAccess?: unknown }).pushAccess) : null); setRepo(""); setBranch(""); setPat(""); router.refresh();
        }}>
          <input aria-label="Repo" className={input} placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <input aria-label="Default branch" className={input} placeholder="default branch (optional)" value={branch} onChange={(e) => setBranch(e.target.value)} />
          <input aria-label="Personal access token (optional)" type="password" autoComplete="off" className={input} placeholder="Personal access token (optional)" value={pat} onChange={(e) => setPat(e.target.value)} />
          <button className={button} disabled={!repo.trim()}>Add repo</button>
        </form>
      ) : <p className="text-xs text-subtle">Only team members can add repos.</p>}
      {notice && <p className="text-sm text-success">{notice}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
