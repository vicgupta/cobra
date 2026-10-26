"use client";

import { useState } from "react";

const input = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) setMessage(j.message);
    else setError(j.error ?? "Something went wrong");
    setBusy(false);
  }

  return (
    <div className="mx-auto mt-8 max-w-sm rounded-xl border border-border bg-surface/40 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
      {message ? (
        <p className="mt-5 text-sm text-fg-soft">{message}</p>
      ) : (
        <form onSubmit={submit} className="mt-5 space-y-4">
          <p className="text-sm text-muted">Enter your account email and we&apos;ll send you a reset link.</p>
          <label className="block space-y-1.5 text-sm">
            <span>Email</span>
            <input required type="email" name="email" autoComplete="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button disabled={busy} className="w-full rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy ? "…" : "Send reset link"}
          </button>
        </form>
      )}
      <p className="mt-4 text-center text-sm"><a href="/login" className="text-accent hover:underline">Back to sign in</a></p>
    </div>
  );
}
