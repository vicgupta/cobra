"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SessionInfo } from "@/lib/auth/sessions";

const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function describe(ua: string): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function SessionsList({ initial }: { initial: SessionInfo[] }) {
  const router = useRouter();
  const [sessions, setSessions] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function end(id: string) {
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setError(j.error ?? "Something went wrong");
    if (j.current) {
      router.replace("/login");
      router.refresh();
      return;
    }
    setSessions((s) => s.filter((x) => x.id !== id));
  }

  async function endOthers() {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/account/sessions/others", { method: "POST" });
    setBusy(false);
    if (!r.ok) return setError((await r.json().catch(() => ({}))).error ?? "Something went wrong");
    setSessions((s) => s.filter((x) => x.current));
  }

  const others = sessions.some((s) => !s.current);
  return (
    <div className="mt-6 space-y-3">
      {sessions.map((s) => (
        <div key={s.id} className="flex items-start justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="min-w-0 text-sm">
            <p className="font-medium text-zinc-200">
              {describe(s.userAgent)}
              {s.current && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-400">This session</span>}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {s.ip || "Unknown IP"} · Signed in {fmt(s.createdAt)} · Last active {fmt(s.lastSeenAt)} · {s.remember ? "Remembered (30 days)" : "Until browser closes (max 12 h)"} · Expires {fmt(s.expiresAt)}
            </p>
            {s.userAgent && <p className="mt-1 truncate text-xs text-zinc-600" title={s.userAgent}>{s.userAgent}</p>}
          </div>
          <button disabled={busy} onClick={() => end(s.id)} className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-900 disabled:opacity-50">
            {s.current ? "Sign out" : "End session"}
          </button>
        </div>
      ))}
      {error && <p className="text-sm text-rose-400">{error}</p>}
      {others && (
        <button disabled={busy} onClick={endOthers} className="rounded-md bg-rose-500/90 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-rose-400 disabled:opacity-50">
          Sign out all other sessions
        </button>
      )}
    </div>
  );
}
