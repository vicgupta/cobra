"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AgentBadge } from "./badges";
import { Badge, Card } from "./ui";
import { RUN_STEPS, STEP_AT, STEP_LABEL, stepAt, type RunStep, type SimulatedRun } from "@/lib/runs";
import type { AgentId } from "@/lib/types";

type Run = SimulatedRun & { step: RunStep };
const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";

export function TestRun() {
  const [form, setForm] = useState({ agent: "claude-code" as AgentId, repo: "vicgupta/cobra", issue: "1", title: "", prompt: "" });
  const [active, setActive] = useState<Run | null>(null);
  const [recent, setRecent] = useState<Run[]>([]);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/runs");
    if (r.ok) setRecent(await r.json());
  }, []);

  useEffect(() => {
    fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : []))
      .then(setRecent)
      .catch(() => {});
  }, []);

  const step = active ? stepAt(active, now) : null;
  const done = step === "pr-opened";

  useEffect(() => {
    if (!active || done) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (stepAt(active, n) === "pr-opened") load();
    }, 250);
    return () => clearInterval(t);
  }, [active, done, load]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, issue: Number(form.issue) }),
    });
    const data = await r.json();
    if (!r.ok) return setError(data.error ?? "Failed to start");
    setNow(Date.now());
    setActive(data);
  }

  const running = !!active && !done;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <Card title="Start a simulated run" className="lg:col-span-3">
        <form onSubmit={start} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span>Agent</span>
            <select className={input} value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value as AgentId })}>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span>Repository</span>
            <input className={input} value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} placeholder="owner/name" required />
          </label>
          <label className="space-y-1.5 text-sm">
            <span>Issue #</span>
            <input className={input} type="number" min={1} value={form.issue} onChange={(e) => setForm({ ...form, issue: e.target.value })} required />
          </label>
          <label className="space-y-1.5 text-sm">
            <span>Issue title</span>
            <input className={input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Add rate limiting" />
          </label>
          <label className="space-y-1.5 text-sm sm:col-span-2">
            <span>Prompt</span>
            <textarea rows={4} className={input} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Extra instructions for the agent…" />
          </label>
          <div className="flex items-center gap-3 sm:col-span-2">
            <button disabled={running} className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
              {running ? "Running…" : "Start"}
            </button>
            {error && <span className="text-xs text-danger">{error}{/approv/i.test(error) && <> — <Link className="underline" href="/workflows/test-run">review the test-run workflow</Link></>}</span>}
          </div>
        </form>
      </Card>

      <Card title="Progress" subtitle={active ? <span className="font-mono">{active.id}</span> : "No run started yet"} className="lg:col-span-2">
        <ol className="space-y-3">
          {RUN_STEPS.map((s, i) => {
            const idx = step ? RUN_STEPS.indexOf(step) : -1;
            const state = !active ? "idle" : i < idx || (done && i === idx) ? "done" : i === idx ? "current" : "idle";
            const elapsed = active ? Math.max(0, Math.min(now - active.startedAt, STEP_AT["pr-opened"]) - STEP_AT[s]) : 0;
            return (
              <li key={s} className="flex items-center gap-3">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                  state === "done" ? "bg-emerald-500 text-zinc-950" : state === "current" ? "animate-pulse bg-sky-500 text-zinc-950" : "bg-surface-2 text-subtle"
                }`}>{state === "done" ? "✓" : i + 1}</span>
                <span className={`flex-1 text-sm ${state === "idle" ? "text-subtle" : ""}`}>{STEP_LABEL[s]}</span>
                {state === "current" && <span className="font-mono text-xs text-subtle">{(elapsed / 1000).toFixed(1)}s</span>}
              </li>
            );
          })}
        </ol>
        {done && <p className="mt-4 text-xs text-success">Simulated PR opened (placeholder) — awaiting human review.</p>}
      </Card>

      <Card title="Recent test runs" subtitle="Stored locally in web/data/runs.json (gitignored)" className="lg:col-span-5">
        {recent.length === 0 ? (
          <p className="text-sm text-subtle">No test runs yet.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-subtle">
                <tr><th className="px-5 pb-2 font-medium">Run</th><th className="px-3 pb-2 font-medium">Issue</th><th className="px-3 pb-2 font-medium">Repo</th><th className="px-3 pb-2 font-medium">Agent</th><th className="px-5 pb-2 font-medium">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-2 font-mono text-xs"><a className="text-success hover:underline" href={`/runs/${r.id}`}>{r.id}</a></td>
                    <td className="px-3 py-2">#{r.issue} {r.title}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.repo}</td>
                    <td className="px-3 py-2"><AgentBadge agent={r.agent} /></td>
                    <td className="px-5 py-2"><Badge tone={r.step === "pr-opened" ? "green" : "blue"} dot>{STEP_LABEL[r.step]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
