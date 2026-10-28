"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { primaryBtn } from "./styles";

const button = primaryBtn;

/** System admins only; the server enforces the same rule (app/api/updates). */
export function UpdatesForm({ enabled, running }: { enabled: boolean; running: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (!running) return; const t = setInterval(() => router.refresh(), 5000); return () => clearInterval(t); }, [running, router]);
  const post = async (body: object, ok: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/updates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; runId?: number };
      setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: d.error ?? `HTTP ${r.status}` });
      if (r.ok) router.push(d.runId ? `/settings/updates?run=${d.runId}` : "/settings/updates");
      router.refresh();
    } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3" data-updates-form>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-emerald-500" aria-label="Daily tool updates" checked={enabled} disabled={busy} onChange={(e) => void post({ enabled: e.target.checked }, e.target.checked ? "Daily updates enabled" : "Daily updates disabled")} /> Update agent tools daily at 4:00 AM ET</label>
      <button className={button} disabled={busy || running} onClick={() => void post({ action: "run" }, "Update started")}>{running ? "Update running…" : "Run update now"}</button>
      {msg && <p role={msg.ok ? undefined : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}
