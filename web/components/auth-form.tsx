"use client";

import { useState } from "react";

const input = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none";

export function AuthForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, remember }) });
    if (r.ok) {
      // Full navigation: the client Router Cache may hold a pre-login prefetch of "/" (a 307 to
      // /login), which made router.replace("/") land back on a blank /login. A real page load
      // sends the new session cookie and renders fresh server state.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation
      window.location.assign("/");
      return;
    }
    setError((await r.json().catch(() => ({}))).error ?? "Something went wrong");
    setBusy(false);
  }

  return (
    <div className="mx-auto mt-8 max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Sign in to Cobra</h1>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <label className="block space-y-1.5 text-sm">
          <span>Email</span>
          <input required type="email" name="email" autoComplete="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span>Password</span>
          <input required type="password" name="password" autoComplete="current-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" name="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-emerald-500" />
          <span>Remember me for 30 days</span>
        </label>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
          {busy ? "…" : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-center text-sm">
        <a href="/forgot-password" className="text-emerald-400 hover:underline">Forgot password?</a>
      </p>
      <p className="mt-2 text-center text-xs text-zinc-500">Accounts are created by an admin.</p>
    </div>
  );
}
