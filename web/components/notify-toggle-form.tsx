"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

/** On/off toggle + test button for a digest. The server enforces who may use it (403 otherwise). */
export function NotifyToggleForm({ api, enabled, label, testLabel, recipients, scope }: { api: string; enabled: boolean; label: string; testLabel: string; recipients: string; scope: "admin" | "team" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const post = async (body: object, ok: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; notifications?: { lastSend?: { status: string; error: string | null } | null }; team?: { lastSend?: { status: string; error: string | null } | null } };
      const ls = (d.notifications ?? d.team)?.lastSend;
      setMsg(r.ok ? (ls && ls.status === "failed" && "action" in body ? { ok: false, text: `Send failed: ${ls.error ?? "unknown error"}` } : { ok: true, text: ok }) : { ok: false, text: d.error ?? `HTTP ${r.status}` });
      if (r.ok) router.refresh();
    } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3" data-notify-form={scope}>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={label} checked={enabled} disabled={busy} onChange={(e) => void post({ enabled: e.target.checked }, e.target.checked ? "Daily digest turned on" : "Daily digest turned off")} /> {label}</label>
      <button className={button} disabled={busy} onClick={() => void post({ action: "test" }, `Test digest sent to ${recipients}`)}>{testLabel}</button>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}
