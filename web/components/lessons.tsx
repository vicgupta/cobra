"use client";
// Agents / Lessons board: pending queue (pending + stale) and history (approved / retired / rejected), grouped
// by repo with a repo filter. Reviewers (team leads, the designated lead, admins of this team) approve, edit,
// reject, retire and reopen; every member can read and add feedback.
import { Fragment, useMemo, useState } from "react";
import { Badge } from "@/components/ui";
import { errText, fieldLabel, ghostBtn, inputCls, primaryBtn, selectCls, subtleDangerBtn } from "@/components/styles";
import type { Lesson } from "@/lib/lessons/store";

type Row = Lesson & { feedbackCount: number };
type View = { lessons: Row[]; canReview: boolean; repos: string[] };
type Detail = { feedback: Array<{ id: number; author: string; text: string; at: number }>; audit: Array<{ actor: string; action: string; detail: string; at: number }> };
type Tab = "queue" | "history";
const QUEUE = ["pending", "stale"], HISTORY = ["approved", "retired", "rejected"];
const statusTone = { pending: "blue", stale: "orange", approved: "green", retired: "gray", rejected: "red" } as const;
const confTone = { high: "green", medium: "amber", low: "gray" } as const;
const flagLabel = { duplicate: "Possible duplicate", sensitive: "Sensitive?", low_confidence: "Low confidence", stale: "Repo idle" } as const;
const when = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function call(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export function LessonsBoard({ initial, focus, initialRepo, initialTab }: { initial: View; focus: number | null; initialRepo: string; initialTab: Tab }) {
  const [view, setView] = useState(initial);
  const focused = initial.lessons.find((l) => l.id === focus);
  const [tab, setTab] = useState<Tab>(focused && HISTORY.includes(focused.status) ? "history" : initialTab);
  const [repo, setRepo] = useState(initialRepo);
  const [hist, setHist] = useState("all");
  const [open, setOpen] = useState<number | null>(focus);
  const reload = async () => setView(await call("/api/lessons?status=all", "GET"));

  const shown = view.lessons.filter((l) => (tab === "queue" ? QUEUE : HISTORY).includes(l.status) && (!repo || l.repo === repo) && (tab === "queue" || hist === "all" || l.status === hist));
  const groups = useMemo(() => { const m = new Map<string, Row[]>(); for (const l of shown) m.set(l.repo, [...(m.get(l.repo) ?? []), l]); return [...m]; }, [shown]);
  const queueN = view.lessons.filter((l) => QUEUE.includes(l.status)).length;

  return (
    <div className="space-y-4" data-testid="lessons-board">
      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex gap-1 rounded-lg border border-border p-1" role="tablist">
          {(["queue", "history"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-tab={t}
              className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg"}`}>
              {t === "queue" ? `Review queue (${queueN})` : "History"}
            </button>
          ))}
        </div>
        <label className="text-sm"><span className={fieldLabel}>Repo</span>
          <select className={selectCls} value={repo} onChange={(e) => setRepo(e.target.value)} data-testid="repo-filter">
            <option value="">All repos</option>{view.repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select></label>
        {tab === "history" && <label className="text-sm"><span className={fieldLabel}>Status</span>
          <select className={selectCls} value={hist} onChange={(e) => setHist(e.target.value)} data-testid="history-filter">
            <option value="all">All</option><option value="approved">Approved</option><option value="retired">Retired</option><option value="rejected">Rejected</option>
          </select></label>}
        {!view.canReview && <p className="text-xs text-subtle">Team leads review lessons; you can read them and add feedback.</p>}
      </div>
      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong px-6 py-10 text-center text-sm text-muted">
          {tab === "queue" ? "Nothing to review. New lessons appear here after runs in your team's repos." : "No lessons here yet."}
        </div>
      ) : groups.map(([r, ls]) => (
        <section key={r} className="space-y-2" data-repo={r}>
          <h2 className="font-mono text-sm font-semibold text-fg">{r} <span className="font-sans font-normal text-subtle">· {ls.length}</span></h2>
          <ul className="space-y-2">{ls.map((l) => <Item key={l.id} l={l} canReview={view.canReview} open={open === l.id} toggle={() => setOpen(open === l.id ? null : l.id)} reload={reload} />)}</ul>
        </section>
      ))}
    </div>
  );
}

function Item({ l, canReview, open, toggle, reload }: { l: Row; canReview: boolean; open: boolean; toggle: () => void; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await f(); await reload(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const act = (action: string) => {
    let reason: string | undefined;
    if (action === "retire" || action === "reject") { reason = window.prompt(action === "retire" ? "Why retire this lesson?" : "Reason (optional)") ?? undefined; if (action === "retire" && !reason) return; }
    void run(() => call(`/api/lessons/${l.id}/action`, "POST", { action, reason }));
  };
  return (
    <li className="rounded-xl border border-border bg-surface/60 p-4 shadow-sm" data-lesson={l.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button onClick={toggle} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-subtle">L{l.id}</span>
            <span className="font-medium text-fg">{l.title}</span>
            <Badge tone={statusTone[l.status]}>{l.status}</Badge>
            <Badge tone={confTone[l.confidenceLabel as keyof typeof confTone] ?? "gray"}>{l.confidenceLabel} confidence</Badge>
            {l.flags.map((f) => <Badge key={f.kind} tone={f.kind === "sensitive" ? "red" : "amber"}>{flagLabel[f.kind]}</Badge>)}
          </div>
          <p className="mt-1 text-sm text-fg-soft"><span className="text-subtle">Happened:</span> {l.whatHappened}</p>
          <p className="text-sm text-fg-soft"><span className="text-subtle">Learned:</span> {l.whatWeLearned}</p>
          {l.status === "stale" && l.staleReason && <p className="mt-1 text-sm text-warning" data-testid="stale-reason">Stale: {l.staleReason}{l.staleRunId && <> · <a href={`/runs/${l.staleRunId}`} className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>run {l.staleRunId}</a></>}</p>}
          {l.status === "retired" && l.retiredReason && <p className="mt-1 text-xs text-subtle">Retired: {l.retiredReason}</p>}
          <p className="mt-1 text-xs text-subtle">{l.kind} · {l.tags.map((t) => `#${t}`).join(" ")} · {l.sourceRunIds.length} run{l.sourceRunIds.length === 1 ? "" : "s"} · {l.feedbackCount} comment{l.feedbackCount === 1 ? "" : "s"} · updated {when(l.updatedAt)}</p>
        </button>
        {canReview && !editing && (
          <div className="flex flex-wrap gap-2">
            {["pending", "stale", "rejected"].includes(l.status) && <button className={primaryBtn} disabled={busy} onClick={() => act("approve")}>Approve</button>}
            {l.status !== "retired" && <button className={ghostBtn} disabled={busy} onClick={() => { setEditing(true); if (!open) toggle(); }}>Edit</button>}
            {["pending", "stale"].includes(l.status) && <button className={subtleDangerBtn} disabled={busy} onClick={() => act("reject")}>Reject</button>}
            {l.status === "approved" && <button className={subtleDangerBtn} disabled={busy} onClick={() => act("retire")}>Retire</button>}
            {["retired", "rejected"].includes(l.status) && <button className={ghostBtn} disabled={busy} onClick={() => act("reopen")}>Reopen</button>}
          </div>
        )}
      </div>
      {err && <p className={`${errText} mt-2`} role="alert">{err}</p>}
      {editing && <EditForm l={l} done={() => setEditing(false)} save={(b) => run(async () => { await call(`/api/lessons/${l.id}`, "PATCH", b); setEditing(false); })} busy={busy} />}
      {open && !editing && <Thread l={l} />}
    </li>
  );
}

function EditForm({ l, save, done, busy }: { l: Row; save: (b: Record<string, unknown>) => void; done: () => void; busy: boolean }) {
  const [f, setF] = useState({ title: l.title, whatHappened: l.whatHappened, whatWeLearned: l.whatWeLearned, tags: l.tags.join(", "), confidence: l.confidenceLabel });
  const field = (k: "title" | "whatHappened" | "whatWeLearned", label: string, max: number) => (
    <label className="block text-sm"><span className={fieldLabel}>{label} <span className="text-faint">({f[k].length}/{max})</span></span>
      <input className={inputCls} maxLength={max} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  return (
    <form className="mt-3 space-y-3 border-t border-border pt-3" data-testid="lesson-edit" onSubmit={(e) => { e.preventDefault(); save({ ...f, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) }); }}>
      {field("title", "Title", 100)}{field("whatHappened", "What happened", 200)}{field("whatWeLearned", "What we learned", 200)}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm"><span className={fieldLabel}>Tags (comma separated)</span><input className={inputCls} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></label>
        <label className="block text-sm"><span className={fieldLabel}>Confidence</span>
          <select className={`${selectCls} w-full`} value={f.confidence} onChange={(e) => setF({ ...f, confidence: e.target.value })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      </div>
      <div className="flex gap-2"><button className={primaryBtn} disabled={busy} type="submit">Save</button><button className={ghostBtn} type="button" onClick={done}>Cancel</button></div>
    </form>
  );
}

function Thread({ l }: { l: Row }) {
  const [d, setD] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const load = async () => { try { setD(await call(`/api/lessons/${l.id}`, "GET")); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const [started, setStarted] = useState(false);
  if (!started) { setStarted(true); void load(); }
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3" data-testid="lesson-thread">
      {l.evidence && <p className="text-xs text-subtle"><span className="font-medium">Evidence:</span> {l.evidence}</p>}
      {l.sourceRunIds.length > 0 && <p className="text-xs text-subtle">Runs: {l.sourceRunIds.slice(-5).map((r, i) => <Fragment key={r}>{i > 0 && ", "}<a href={`/runs/${r}`} className="text-accent hover:underline">{r}</a></Fragment>)}</p>}
      <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">Feedback</h3>
      {!d ? <p className="text-sm text-subtle">Loading…</p> : d.feedback.length === 0 ? <p className="text-sm text-muted">No feedback yet.</p> : (
        <ul className="space-y-2">{d.feedback.map((c) => <li key={c.id} className="rounded-lg bg-surface-2/50 px-3 py-2 text-sm"><span className="font-medium">{c.author}</span> <span className="text-xs text-subtle">{when(c.at)}</span><p className="whitespace-pre-wrap text-fg-soft">{c.text}</p></li>)}</ul>
      )}
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; try { await call(`/api/lessons/${l.id}/feedback`, "POST", { text }); setText(""); await load(); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } }}>
        <input className={inputCls} placeholder="Add feedback…" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} aria-label="Feedback" />
        <button className={ghostBtn} type="submit">Post</button>
      </form>
      {err && <p className={errText}>{err}</p>}
      {d && d.audit.length > 0 && <details className="text-xs text-subtle"><summary>History ({d.audit.length})</summary><ul className="mt-1 space-y-0.5">{d.audit.map((a, i) => <li key={i}>{when(a.at)} · {a.actor} · {a.action}{a.detail && ` — ${a.detail}`}</li>)}</ul></details>}
    </div>
  );
}
