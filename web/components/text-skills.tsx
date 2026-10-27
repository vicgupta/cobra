"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50";

export function TextSkillRun({ skill, repos, engines }: { skill: string; repos: string[]; engines: string[] }) {
  const [prompt, setPrompt] = useState(""), [repo, setRepo] = useState(""), [mode, setMode] = useState("simulated"), [engine, setEngine] = useState(engines[0] ?? "claude-code");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <form className="mt-3 space-y-2" data-testid={`text-skill-run-${skill}`} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(null);
      const res = await fetch("/api/text-skills/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill, prompt, repo: repo || undefined, mode, engine }) });
      const data = await res.json().catch(() => ({}));
      setBusy(false);
      if (!res.ok || !data.id) return setError(data.error ?? "Failed");
      router.push(`/runs/${encodeURIComponent(data.id)}`);
    }}>
      <textarea aria-label="Prompt" className={`${input} h-20`} placeholder="Describe the task, e.g. ship: add a dark-mode toggle to the settings page" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select aria-label="Repo" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}><option value="">No repo (scratch)</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}</select>
        <select aria-label="Engine" className={input} value={engine} onChange={(e) => setEngine(e.target.value)}>{engines.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        <select aria-label="Run type" className={input} value={mode} onChange={(e) => setMode(e.target.value)}><option value="simulated">Test run</option><option value="real">Real run</option></select>
      </div>
      <button className={button} disabled={busy || !prompt.trim()}>{busy ? "Starting…" : "Run skill"}</button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </form>
  );
}
