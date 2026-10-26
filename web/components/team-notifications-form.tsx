"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

/** Leads/admins edit the team settings; everyone manages only their own opt-out. The API enforces the same rules. */
export function TeamNotificationsForm({ canEdit, enabled, mode, myOptOut, email }: { canEdit: boolean; enabled: boolean; mode: "leads" | "all"; myOptOut: boolean; email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const post = async (body: object, ok: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/team-notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; notifications?: { lastSend?: { status: string; error: string | null } | null } };
      const ls = d.notifications?.lastSend;
      setMsg(r.ok ? (ls && ls.status === "failed" && "action" in body ? { ok: false, text: `Send failed: ${ls.error ?? "unknown error"}` } : { ok: true, text: ok }) : { ok: false, text: d.error ?? `HTTP ${r.status}` });
      if (r.ok) router.refresh();
    } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4" data-team-notifications-form>
      {canEdit && (
        <>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Team daily email" checked={enabled} disabled={busy} onChange={(e) => void post({ enabled: e.target.checked }, e.target.checked ? "Team daily email enabled" : "Team daily email disabled")} /> Send the team daily email</label>
          <fieldset className="space-y-1 text-sm" data-recipients-mode={mode}>
            <legend className="font-medium">Recipients</legend>
            <label className="flex items-center gap-2"><input type="radio" name="recipients" value="leads" checked={mode === "leads"} disabled={busy} onChange={() => void post({ recipients: "leads" }, "Recipients: Team leads")} /> Team leads <span className="text-xs text-subtle">(team leads and the designated lead)</span></label>
            <label className="flex items-center gap-2"><input type="radio" name="recipients" value="all" checked={mode === "all"} disabled={busy} onChange={() => void post({ recipients: "all" }, "Recipients: Entire team")} /> Entire team <span className="text-xs text-subtle">(every member)</span></label>
          </fieldset>
        </>
      )}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Opt out of my copy" checked={myOptOut} disabled={busy} onChange={(e) => void post({ optOut: e.target.checked }, e.target.checked ? "You won't get the team email" : "You'll get the team email when you're a recipient")} /> Don&apos;t send me this email ({email})</label>
      {canEdit && <button className={button} disabled={busy} onClick={() => void post({ action: "test" }, `Test sent to ${email}`)}>Send test now</button>}
      {msg && <p role={msg.ok ? undefined : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}
