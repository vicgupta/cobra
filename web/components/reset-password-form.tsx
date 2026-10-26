"use client";

import { useState } from "react";

const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";

export function ResetPasswordForm({ token, initialError }: { token: string; initialError: string | null }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/reset-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) });
    if (r.ok) setDone(true);
    else setError((await r.json().catch(() => ({}))).error ?? "Something went wrong");
    setBusy(false);
  }

  return (
    <div className="mx-auto mt-8 max-w-sm rounded-xl border border-border bg-surface/40 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
      {done ? (
        <p className="mt-5 text-sm text-fg-soft">Your password has been changed and you&apos;ve been signed out everywhere. <a href="/login" className="text-accent hover:underline">Sign in</a></p>
      ) : initialError ? (
        <p className="mt-5 text-sm text-danger">{initialError} <a href="/forgot-password" className="text-accent hover:underline">Request a new link</a></p>
      ) : (
        <form onSubmit={submit} className="mt-5 space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>New password (at least 10 characters)</span>
            <input required minLength={10} type="password" name="password" autoComplete="new-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Confirm new password</span>
            <input required minLength={10} type="password" name="confirm" autoComplete="new-password" className={input} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button disabled={busy} className="w-full rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy ? "…" : "Set new password"}
          </button>
        </form>
      )}
    </div>
  );
}
