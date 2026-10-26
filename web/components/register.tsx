"use client";
// /register: invite acceptance, or (no token) sign in + "Create a new team" / "Join an existing team".
import { useState } from "react";

const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";
const primary = "w-full rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50";
const shell = "mx-auto mt-8 max-w-md rounded-xl border border-border bg-surface/40 p-6";

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: (await r.json().catch(() => ({}))) as { error?: string; message?: string; kind?: string } };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5 text-sm"><span>{label}</span>{children}</label>;
}

export function InviteAccept({ token, team, email }: { token: string; team: string; email: string }) {
  const [name, setName] = useState(""), [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await post("/api/auth/register", { mode: "invite", invite: token, name, password });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load with the new session
    if (r.ok) { window.location.assign("/"); return; }
    setError(r.data.error ?? "Something went wrong"); setBusy(false);
  }
  return (
    <div className={shell} data-register="invite">
      <h1 className="text-xl font-semibold tracking-tight">Join {team}</h1>
      <p className="mt-1 text-sm text-muted">Create your Cobra account to join the team.</p>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="Email"><input type="email" className={`${input} opacity-70`} value={email} readOnly disabled aria-readonly /></Field>
        <Field label="Your name"><input required name="name" autoComplete="name" className={input} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Password (at least 10 characters)"><input required minLength={10} type="password" name="password" autoComplete="new-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className={primary}>{busy ? "…" : `Join ${team}`}</button>
      </form>
    </div>
  );
}

export function InviteError({ error }: { error: string }) {
  return (
    <div className={shell} data-register="invite-error">
      <h1 className="text-xl font-semibold tracking-tight">Invite link problem</h1>
      <p role="alert" className="mt-4 text-sm text-danger">{error}</p>
      <p className="mt-4 text-sm"><a href="/login" className="text-accent hover:underline">Sign in</a> · <a href="/register" className="text-accent hover:underline">Other ways to join</a></p>
    </div>
  );
}

export function RegisterChooser({ initial, signupsOpen }: { initial: "create" | "join"; signupsOpen: boolean }) {
  const [mode, setMode] = useState<"create" | "join">(initial);
  const [f, setF] = useState({ email: "", name: "", password: "", teamName: "", team: "" });
  const [error, setError] = useState<string | null>(null), [done, setDone] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const body = mode === "create" ? { mode, email: f.email, name: f.name, password: f.password, teamName: f.teamName } : { mode, email: f.email, name: f.name, team: f.team };
    const r = await post("/api/auth/register", body);
    if (r.ok) setDone(r.data.message ?? "Check your email."); else setError(r.data.error ?? "Something went wrong");
    setBusy(false);
  }
  const tab = (m: "create" | "join", label: string) => (
    <button type="button" role="tab" aria-selected={mode === m} data-mode={m} onClick={() => { setMode(m); setError(null); setDone(null); }}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${mode === m ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>{label}</button>
  );
  return (
    <div className={shell} data-register={mode}>
      <h1 className="text-xl font-semibold tracking-tight">Get started with Cobra</h1>
      <p className="mt-1 text-sm text-muted">Already have an account? <a href="/login" className="text-accent hover:underline">Sign in</a></p>
      <div role="tablist" className="mt-5 flex gap-1 rounded-lg border border-border p-1">{tab("create", "Create a new team")}{tab("join", "Join an existing team")}</div>
      {done ? <p className="mt-5 text-sm text-fg-soft" role="status">{done}</p> : mode === "create" && !signupsOpen ? (
        <p className="mt-5 text-sm text-muted">New team sign-ups are turned off right now. Ask a team lead to send you an invite link.</p>
      ) : (
        <form onSubmit={submit} className="mt-5 space-y-4">
          <Field label="Email"><input required type="email" name="email" autoComplete="email" className={input} value={f.email} onChange={set("email")} /></Field>
          <Field label="Your name"><input required name="name" autoComplete="name" className={input} value={f.name} onChange={set("name")} /></Field>
          {mode === "create" ? <>
            <Field label="Password (at least 10 characters)"><input required minLength={10} type="password" name="password" autoComplete="new-password" className={input} value={f.password} onChange={set("password")} /></Field>
            <Field label="Team name"><input required minLength={2} maxLength={60} name="teamName" className={input} value={f.teamName} onChange={set("teamName")} /></Field>
            <p className="text-xs text-subtle">We&apos;ll email you a link to confirm your address. Your team is created when you confirm, and you become its team lead.</p>
          </> : <>
            <Field label="Team name or slug"><input required name="team" autoComplete="off" className={input} value={f.team} onChange={set("team")} /></Field>
            <p className="text-xs text-subtle">Type the exact team name or its slug (ask your team lead). After you confirm your email, the team&apos;s lead is notified and can send you an invite link.</p>
          </>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <button disabled={busy} className={primary}>{busy ? "…" : mode === "create" ? "Create team" : "Request to join"}</button>
        </form>
      )}
    </div>
  );
}

export function ConfirmSignup({ token, kind }: { token: string; kind: "create_team" | "join" | null }) {
  const [error, setError] = useState<string | null>(kind ? null : "This confirmation link isn't valid or has expired. Start again from the sign-up page.");
  const [done, setDone] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true); setError(null);
    const r = await post("/api/auth/register/confirm", { token });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load with the new session
    if (r.ok && r.data.kind === "create_team") { window.location.assign("/settings/team"); return; }
    if (r.ok) setDone(r.data.message ?? "Confirmed."); else setError(r.data.error ?? "Something went wrong");
    setBusy(false);
  }
  return (
    <div className={shell} data-register="confirm">
      <h1 className="text-xl font-semibold tracking-tight">{kind === "create_team" ? "Confirm and create your team" : "Confirm your email"}</h1>
      {done ? <p className="mt-4 text-sm text-fg-soft" role="status">{done}</p> : error ? (
        <p role="alert" className="mt-4 text-sm text-danger">{error} <a href="/register" className="text-accent hover:underline">Sign-up page</a></p>
      ) : (
        <button onClick={confirm} disabled={busy} className={`${primary} mt-5`}>{busy ? "…" : kind === "create_team" ? "Confirm email and create team" : "Confirm email"}</button>
      )}
    </div>
  );
}
