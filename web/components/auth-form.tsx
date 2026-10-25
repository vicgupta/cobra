"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none";
type Field = { name: string; label: string; type?: string; autoComplete?: string };

export function AuthForm({ mode, signupAllowed = true }: { mode: "login" | "signup"; signupAllowed?: boolean }) {
  const fields: Field[] = mode === "login"
    ? [{ name: "login", label: "Email or username", autoComplete: "username" }, { name: "password", label: "Password", type: "password", autoComplete: "current-password" }]
    : [
        { name: "name", label: "Your name", autoComplete: "name" },
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        { name: "password", label: "Password (10+ characters)", type: "password", autoComplete: "new-password" },
        { name: "team", label: "Team / workspace name", autoComplete: "organization" },
      ];
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
    if (r.ok) {
      router.replace("/");
      router.refresh();
      return;
    }
    setError((await r.json().catch(() => ({}))).error ?? "Something went wrong");
    setBusy(false);
  }

  return (
    <div className="mx-auto mt-8 max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
      <h1 className="text-xl font-semibold tracking-tight">{mode === "login" ? "Sign in to Cobra" : "Create a workspace"}</h1>
      <form onSubmit={submit} className="mt-5 space-y-4">
        {fields.map((f) => (
          <label key={f.name} className="block space-y-1.5 text-sm">
            <span>{f.label}</span>
            <input required name={f.name} type={f.type ?? "text"} autoComplete={f.autoComplete} className={input}
              value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
          </label>
        ))}
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
          {busy ? "…" : mode === "login" ? "Sign in" : "Create workspace"}
        </button>
      </form>
      <p className="mt-4 text-center text-xs text-zinc-500">
        {mode === "login"
          ? signupAllowed && <>New here? <Link href="/signup" className="text-emerald-400 hover:underline">Create a workspace</Link></>
          : <>Have an account? <Link href="/login" className="text-emerald-400 hover:underline">Sign in</Link></>}
      </p>
    </div>
  );
}
