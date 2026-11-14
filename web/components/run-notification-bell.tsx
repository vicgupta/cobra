"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BellIcon } from "./icons";

export type BellItem = { id: number; runId: string | null; title: string; body: string; status: "ok" | "failed"; readAt: number | null; createdAt: number };

export function RunNotificationBell({ initial }: { initial: { unread: number; notifications: BellItem[] } }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initial.unread);
  const [items, setItems] = useState(initial.notifications);
  const box = useRef<HTMLDivElement>(null);

  const load = async (url: string, method: string, body?: unknown) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) as { unread?: number; notifications?: BellItem[] } };
  };
  const refresh = async () => {
    const r = await load("/api/run-notifications", "GET");
    if (!r.ok) return;
    setUnread(Number(r.data.unread) || 0);
    if (Array.isArray(r.data.notifications)) setItems(r.data.notifications);
  };

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (open && box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    const pull = () => { void refresh(); };
    const id = setInterval(() => { if (document.visibilityState === "visible") pull(); }, 30_000);
    window.addEventListener("focus", pull);
    return () => { clearInterval(id); window.removeEventListener("focus", pull); };
    // refresh is recreated each render; interval should stay stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mark = async (ids: number[] | "all") => {
    const body = ids === "all" ? { all: true } : { ids };
    const r = await load("/api/run-notifications", "POST", body);
    if (r.ok) { setUnread(Number(r.data.unread) || 0); setItems((cur) => cur.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? Date.now() } : n))); }
  };

  return (
    <div className="relative" ref={box} data-run-notifications>
      <button type="button" className="relative rounded-md p-1.5 text-muted hover:bg-surface hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={unread ? `${unread} unread run notification${unread === 1 ? "" : "s"}` : "Run notifications"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <BellIcon className="h-5 w-5" />
        {unread > 0 && <span data-unread-count className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="text-sm font-medium text-fg">Run notifications</p>
            {unread > 0 && <button type="button" className="text-xs text-accent hover:underline" onClick={() => void mark("all")}>Mark all read</button>}
          </div>
          {items.length === 0 ? <p className="px-3 py-6 text-center text-sm text-subtle">No notifications yet.</p> : (
            <ul className="max-h-96 overflow-y-auto divide-y divide-border">
              {items.map((n) => (
                <li key={n.id} className={n.readAt ? "bg-surface" : "bg-surface-2/60"}>
                  {n.runId ? (
                    <Link href={`/runs/${encodeURIComponent(n.runId)}`} className="block px-3 py-2 hover:bg-surface-2" onClick={() => { if (!n.readAt) void mark([n.id]); setOpen(false); }}>
                      <Item n={n} />
                    </Link>
                  ) : (
                    <div className="px-3 py-2"><Item n={n} /></div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ n }: { n: BellItem }) {
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(n.createdAt)) + " ET";
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className={`text-sm ${n.readAt ? "font-normal text-fg-soft" : "font-medium text-fg"}`}>{n.title}</p>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${n.status === "ok" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-red-500/15 text-red-700 dark:text-red-400"}`}>{n.status === "ok" ? "ok" : "failed"}</span>
      </div>
      <p className="mt-0.5 text-xs text-subtle">{when}</p>
    </>
  );
}
