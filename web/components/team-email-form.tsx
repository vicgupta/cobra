"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fieldLabel, ghostBtn, inputCls, primaryBtn, subtleDangerBtn } from "./styles";

/** Pick a name (local part @kantsy.com) and request the mailbox. Replacing or removing asks for confirmation.
 *  The server enforces who may do this; responses never include the token. */
export function TeamEmailForm({ current }: { current: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(""), [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const call = async (method: "POST" | "DELETE", body?: object, ok?: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/team-email", { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const d = (await r.json().catch(() => ({}))) as { error?: string; email?: { address: string } | null };
      if (r.ok) { setMsg({ ok: true, text: ok ?? (d.email ? `Team email is now ${d.email.address}` : "Done") }); setName(""); setConfirm(false); router.refresh(); }
      else setMsg({ ok: false, text: d.error ?? `HTTP ${r.status}` });
    } finally { setBusy(false); }
  };
  const valid = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(name);
  const submit = () => {
    if (current && !confirm) { setConfirm(true); return; }
    void call("POST", { name, displayName: displayName.trim() || undefined, replace: !!current });
  };
  return (
    <div className="space-y-3" data-team-email-form>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div>
          <label htmlFor="team-email-name" className={fieldLabel}>{current ? "New name" : "Name"}</label>
          <div className="flex items-center gap-1"><input id="team-email-name" className={`${inputCls} w-48`} value={name} maxLength={32} placeholder="my-team" onChange={(e) => { setName(e.target.value.toLowerCase()); setConfirm(false); }} /><span className="text-sm text-subtle">@kantsy.com</span></div>
        </div>
        <div>
          <label htmlFor="team-email-display" className={fieldLabel}>Display name (optional)</label>
          <input id="team-email-display" className={`${inputCls} w-48`} value={displayName} maxLength={60} placeholder="Cobra team" onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <button className={primaryBtn} disabled={busy || !valid}>{busy ? "Requesting…" : current ? (confirm ? `Confirm: replace ${current}` : "Replace team email") : "Request email"}</button>
        {confirm && <button type="button" className={ghostBtn} onClick={() => setConfirm(false)}>Cancel</button>}
      </form>
      <p className="text-xs text-subtle">2–32 lowercase letters, digits or “-”. kantsy.com creates the address and gives Cobra a token once; it is stored encrypted.{current ? " Replacing switches every agent to the new address; the old mailbox stays at kantsy.com but Cobra forgets its token." : ""}</p>
      {current && <button type="button" className={subtleDangerBtn} disabled={busy} onClick={() => { if (window.confirm(`Remove ${current} from this team? Cobra deletes its stored token; agents lose email access.`)) void call("DELETE", undefined, "Team email removed"); }}>Remove team email</button>}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}
