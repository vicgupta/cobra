"use client";
// Settings > Team: invite by email, revoke, join requests (send magic link / dismiss), admin sign-up toggle.
import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "rounded-md border border-border-strong bg-bg px-3 py-1.5 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";
const button = "rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50";

function useCall() {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  async function run(url: string, method: string, body: unknown, ok: (d: Record<string, unknown>) => string) {
    setBusy(true); setError(null); setNote(null);
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (r.ok) { setNote(ok(d)); router.refresh(); } else setError(d.error ?? `HTTP ${r.status}`);
    setBusy(false);
    return r.ok;
  }
  const status = <>{error && <span role="alert" className="text-sm text-danger">{error}</span>}{note && <span className="text-sm text-success">{note}</span>}</>;
  return { busy, run, status };
}
const mailed = (d: Record<string, unknown>, what: string) => (d.mailError ? `${what}, but the email failed: ${String(d.mailError)}` : `${what} and emailed`);

export function InviteForm({ canInviteLead }: { canInviteLead: boolean }) {
  const c = useCall();
  const [email, setEmail] = useState(""), [role, setRole] = useState("member");
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={async (e) => { e.preventDefault(); if (await c.run("/api/team/invites", "POST", { email, role }, (d) => mailed(d, "Invite created"))) setEmail(""); }}>
      <input required type="email" aria-label="Invite email" placeholder="name@example.com" className={`${input} min-w-64`} value={email} onChange={(e) => setEmail(e.target.value)} />
      {canInviteLead && <select aria-label="Invite role" className={input} value={role} onChange={(e) => setRole(e.target.value)}><option value="member">Member</option><option value="team_lead">Team lead</option></select>}
      <button className={button} disabled={c.busy}>Send invite link</button>{c.status}
    </form>
  );
}

export function RevokeInvite({ id }: { id: number }) {
  const c = useCall();
  return <span className="flex items-center gap-2"><button className={ghost} disabled={c.busy} onClick={() => void c.run(`/api/team/invites/${id}`, "DELETE", {}, () => "Revoked")}>Revoke</button>{c.status}</span>;
}

export function JoinRequestActions({ id, resend }: { id: number; resend: boolean }) {
  const c = useCall();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button className={button} disabled={c.busy} onClick={() => void c.run(`/api/team/join-requests/${id}`, "POST", { action: "send_link" }, (d) => mailed(d, "Magic link created"))}>{resend ? "Resend magic link" : "Send magic link"}</button>
      <button className={ghost} disabled={c.busy} onClick={() => void c.run(`/api/team/join-requests/${id}`, "POST", { action: "dismiss" }, () => "Dismissed")}>Dismiss</button>
      {c.status}
    </span>
  );
}

export function SignupToggle({ allow }: { allow: boolean }) {
  const c = useCall();
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="accent-emerald-500" checked={allow} disabled={c.busy} onChange={(e) => void c.run("/api/team/signups", "PUT", { allow: e.target.checked }, (d) => (d.allowTeamSignups ? "New team sign-ups on" : "New team sign-ups off"))} />
      <span>Allow new team sign-ups (anyone can create a team after verifying their email)</span>{c.status}
    </label>
  );
}
