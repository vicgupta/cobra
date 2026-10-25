"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function EndSessionButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        disabled={busy}
        onClick={async () => {
          if (!confirm("End this session? The user will be signed out on that device.")) return;
          setBusy(true);
          const r = await fetch(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
          setBusy(false);
          if (r.ok) router.refresh();
          else setErr((await r.json().catch(() => ({}))).error ?? "Failed");
        }}
        className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        {busy ? "Ending…" : "End"}
      </button>
      {err && <span className="text-xs text-rose-400">{err}</span>}
    </span>
  );
}
