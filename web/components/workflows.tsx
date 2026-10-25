"use client";

// Workflow UI pieces. Editing is plain YAML in a textarea, validated on the server.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, type Tone } from "./ui";

const input = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50";
const ghost = "rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";

const STATUS_TONE: Record<string, Tone> = { approved: "green", pending: "amber", rejected: "red", running: "blue", succeeded: "green", failed: "red", skipped: "gray" };
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
    <ul role="alert" className="space-y-1 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 font-mono text-xs text-rose-200">
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
export function YamlEditor({ initial, previousName, templateName, storage: st }: { initial: string; previousName?: string; templateName?: string; storage?: StorageInit }) {
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
      <fieldset className="space-y-2 rounded-md border border-zinc-800 p-3 text-sm">
        <legend className="px-1 text-xs text-zinc-400">Storage</legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-2"><input type="radio" name="storage" checked={storage === "database"} onChange={() => setStorage("database")} /> Cobra database</label>
          <label className="flex items-center gap-2"><input type="radio" name="storage" checked={storage === "github"} onChange={() => setStorage("github")} /> GitHub repo file</label>
        </div>
        {storage === "github" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input aria-label="GitHub repo" className={input} placeholder="owner/repo" value={gh.repo} onChange={(e) => setGh({ ...gh, repo: e.target.value })} />
            <input aria-label="File path" className={input} placeholder=".cobra/workflows/my-workflow.yaml" value={gh.path} onChange={(e) => setGh({ ...gh, path: e.target.value })} />
            <input aria-label="Branch" className={input} placeholder="branch (default branch if empty)" value={gh.branch} onChange={(e) => setGh({ ...gh, branch: e.target.value })} />
            {!previousName && <label className="flex items-center gap-2 text-xs text-zinc-400 sm:col-span-3"><input type="checkbox" checked={importing} onChange={(e) => setImporting(e.target.checked)} /> Import the existing file instead of the YAML below</label>}
            <p className="text-xs text-zinc-500 sm:col-span-3">Read and written with the server&apos;s GITHUB_TOKEN. Saving commits the file.</p>
          </div>
        )}
      </fieldset>
      {!(storage === "github" && importing) && <textarea aria-label="Workflow YAML" className={`${input} min-h-[28rem] font-mono text-xs leading-5`} spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} />}
      <Errors errors={errors} />
      <div className="flex items-center gap-3">
        <button className={button} disabled={busy || (!source.trim() && !importing)} onClick={save}>{busy ? "Validating…" : previousName ? "Save changes" : importing ? "Import" : "Create"}</button>
        <p className="text-xs text-zinc-500">Validated on the server. Saving new content resets approval: approvers must approve this exact version before it can run.</p>
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
      {msg && <span className="text-xs text-zinc-400">{msg}</span>}
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
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <div className="flex items-center gap-2">
        <button className={button} disabled={busy} onClick={() => decide("approve")}>Approve</button>
        <button className={`${ghost} border-rose-500/40 text-rose-200`} disabled={busy} onClick={() => decide("reject")}>Reject</button>
        <span className="font-mono text-xs text-zinc-500">version {hash.slice(0, 12)}</span>
      </div>
    </div>
  );
}

export type InputDef = { type: "string" | "number" | "boolean" | "choice"; description?: string; required?: boolean; default?: string | number | boolean; options?: string[] };

export function RunForm({ name, inputs, enabled, reason }: { name: string; inputs: Record<string, InputDef>; enabled: boolean; reason?: string }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(Object.entries(inputs).map(([k, d]) => [k, d.type === "boolean" ? Boolean(d.default) : d.default === undefined ? "" : String(d.default)])));
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
    const { ok, data } = await send(`/api/workflows/${encodeURIComponent(name)}/runs`, { inputs: payload });
    setBusy(false);
    if (!ok) return setErrors(data.errors ?? [data.error ?? "Run failed"]);
    router.push(`/runs/${data.id}`);
  }
  return (
    <form onSubmit={run} className="space-y-3">
      {Object.entries(inputs).map(([k, d]) => (
        <label key={k} className="block text-sm">
          <span className="text-zinc-300">{k}{d.required && <span className="text-rose-300"> *</span>}</span>
          {d.description && <span className="ml-2 text-xs text-zinc-500">{d.description}</span>}
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
      {!enabled && reason && <p className="text-xs text-zinc-500">{reason}</p>}
    </form>
  );
}

type Event = { stepId: string; status: string; attempt: number; output: string | null; truncated: boolean; at: number };
type Detail = { id: string; workflow: string | null; workflowHash: string | null; status: string | null; error: string | null; startedAt: number; endedAt: number | null; outputs: Record<string, unknown> | null; events: Event[] };

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
        {run.workflow && <Link className="text-emerald-300 hover:underline" href={`/workflows/${encodeURIComponent(run.workflow)}`}>{run.workflow}</Link>}
        <span className="font-mono text-xs text-zinc-500">version {run.workflowHash?.slice(0, 12)}</span>
        <span className="text-xs text-zinc-500">started {new Date(run.startedAt).toLocaleString()}{run.endedAt ? ` · ended ${t(run.endedAt)}` : ""}</span>
      </div>
      {run.error && <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{run.error}</p>}
      <ol className="space-y-2">
        {run.events.map((e, i) => (
          <li key={i} className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
            <div className="flex items-center gap-3 text-xs">
              <span className="font-mono text-zinc-500">{t(e.at)}</span>
              <span className="font-mono text-zinc-200">{e.stepId}</span>
              <StatusBadge status={e.status} />
              {e.attempt > 1 && <span className="text-zinc-500">attempt {e.attempt}</span>}
            </div>
            {e.output && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs text-zinc-300">{e.output}</pre>}
            {e.truncated && <p className="mt-1 text-xs text-amber-300">Output truncated.</p>}
          </li>
        ))}
      </ol>
      {run.outputs && Object.keys(run.outputs).length > 0 && (
        <pre className="overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs">{JSON.stringify(run.outputs, null, 2)}</pre>
      )}
    </div>
  );
}
