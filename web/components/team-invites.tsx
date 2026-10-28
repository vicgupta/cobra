"use client";
// Settings > Team: invite by email, revoke, join requests (send magic link / dismiss), admin sign-up toggle.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ghostBtn, inputCls, primaryBtn, selectCls } from "./styles";

const input = inputCls.replace("w-full ", "");
const button = primaryBtn;
const ghost = ghostBtn;

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
      {canInviteLead && <select aria-label="Invite role" className={selectCls} value={role} onChange={(e) => setRole(e.target.value)}><option value="member">Member</option><option value="team_lead">Team lead</option></select>}
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
      <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={allow} disabled={c.busy} onChange={(e) => void c.run("/api/team/signups", "PUT", { allow: e.target.checked }, (d) => (d.allowTeamSignups ? "New team sign-ups on" : "New team sign-ups off"))} />
      <span>Allow new team sign-ups (anyone can create a team after verifying their email)</span>{c.status}
    </label>
  );
}

/** System admins: create a team (and move into it). */
export function CreateTeamForm() {
  const c = useCall();
  const [name, setName] = useState("");
  return (
    <form className="flex flex-wrap items-center gap-2" data-create-team onSubmit={async (e) => { e.preventDefault(); if (await c.run("/api/team/teams", "POST", { name, join: true }, () => "Team created; you're now in it")) setName(""); }}>
      <input required aria-label="New team name" placeholder="Team name" maxLength={80} className={`${input} min-w-64`} value={name} onChange={(e) => setName(e.target.value)} />
      <button className={button} disabled={c.busy}>Create team</button>{c.status}
    </form>
  );
}

/** System admins: move into an existing team. */
export function JoinTeamButton({ id, name }: { id: number; name: string }) {
  const c = useCall();
  return <span className="flex items-center gap-2"><button className={ghost} disabled={c.busy} onClick={() => { if (confirm(`Move to team "${name}"? You'll see that team's skills, agents and repos instead of this one's.`)) void c.run(`/api/team/teams/${id}/join`, "POST", {}, () => `Joined ${name}`); }}>Join</button>{c.status}</span>;
}
