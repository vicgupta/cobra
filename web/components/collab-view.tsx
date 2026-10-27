// Server-rendered pieces for the issues and PR pages (shared layout so both areas look the same).
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, type Tone } from "./ui";
import type { AuditRow } from "@/lib/collab";
import type { GhComment } from "@/lib/github-api";

const dt = (t: number | string | null) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const LABEL: Record<string, string> = { issue_create: "created issue", agent_issue: "agent wrote issue", pr_create: "opened PR", comment: "commented", merge: "merged" };
export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

/** Issue/PR state as a badge with a dot: open (green), merged (violet), draft/closed (gray). */
export function StateBadge({ state }: { state: "open" | "closed" | "merged" | "draft" | string }) {
  const tone: Tone = state === "open" ? "green" : state === "merged" ? "violet" : "gray";
  return <Badge tone={tone} dot>{state}</Badge>;
}

/** Initial-letter avatar for a GitHub login. */
export function Avatar({ login }: { login?: string | null }) {
  return <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold uppercase text-fg-soft ring-1 ring-border">{(login ?? "?").slice(0, 1)}</span>;
}

/** One row in an issue/PR list: the whole row is the link, with a 44px+ tap target. */
export function ItemRow({ href, number, title, state, meta, badges }: { href: string; number: number; title: string; state: string; meta: ReactNode; badges?: ReactNode }) {
  return (
    <li>
      <Link href={href} className={`group flex items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-surface-2/70 sm:px-4 ${focusRing}`}>
        <span className="mt-0.5 hidden sm:block"><StateBadge state={state} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[15px] font-medium leading-snug text-fg group-hover:text-accent">{title}</span>
            <span className="text-sm tabular-nums text-subtle">#{number}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
            <span className="sm:hidden"><StateBadge state={state} /></span>
            {meta}
          </span>
          {badges && <span className="mt-2 flex flex-wrap gap-1.5">{badges}</span>}
        </span>
        <span aria-hidden className="mt-1 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg-soft">›</span>
      </Link>
    </li>
  );
}

/** Dashed empty-state panel. */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
      <p className="text-sm font-medium text-fg-soft">{title}</p>
      {hint && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

/** Skeleton rows shown while a list streams in. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      <div className="h-7 w-64 animate-pulse rounded bg-surface-2" />
      <div className="rounded-xl border border-border bg-surface/60 p-4">
        {Array.from({ length: rows }, (_, i) => <div key={i} className="flex items-center gap-3 py-3"><div className="h-5 w-14 animate-pulse rounded-full bg-surface-2" /><div className="h-4 flex-1 animate-pulse rounded bg-surface-2" /></div>)}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Title block for an issue/PR detail page. */
export function DetailHeader({ title, number, state, meta, href }: { title: string; number: number; state: string; meta: ReactNode; href: string }) {
  return (
    <header className="space-y-3">
      <h2 className="text-xl font-semibold leading-tight tracking-tight text-fg sm:text-2xl">{title} <span className="font-normal text-subtle">#{number}</span></h2>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
        <StateBadge state={state} />
        <span className="min-w-0">{meta}</span>
        <a className={`ml-auto inline-flex min-h-9 items-center gap-1 rounded-md border border-border-strong px-3 text-xs font-medium text-fg-soft hover:bg-surface-2 ${focusRing}`} href={href} target="_blank" rel="noreferrer">View on GitHub ↗</a>
      </div>
    </header>
  );
}

export function Body({ text }: { text: string | null }) {
  return text ? <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-fg-soft">{text}</pre> : <p className="text-sm italic text-subtle">(no description)</p>;
}

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <Card title="Audit" subtitle="Who did each step in Cobra.">
      {rows.length === 0 ? <p className="text-sm text-subtle">Nothing recorded yet.</p> : (<>
        <table className="hidden w-full text-left text-sm md:table"><thead className="text-xs text-subtle"><tr><th className="py-2 font-medium">When</th><th className="font-medium">Who</th><th className="font-medium">Action</th><th className="font-medium">Run</th><th className="font-medium">Detail</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="border-t border-border"><td className="py-2 pr-3 text-xs tabular-nums text-muted">{dt(r.at)}</td><td className="pr-3">{r.actorEmail}</td><td className="pr-3"><Badge tone={r.action === "merge" ? "violet" : "gray"}>{LABEL[r.action] ?? r.action}</Badge></td>
            <td className="pr-3">{r.runId ? <Link className="font-mono text-xs underline" href={`/runs/${r.runId}`}>{r.runId}</Link> : "—"}</td><td className="text-xs text-muted">{r.detail}</td></tr>)}</tbody></table>
        <ul className="divide-y divide-border md:hidden">{rows.map((r) => (
          <li key={r.id} className="space-y-1 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={r.action === "merge" ? "violet" : "gray"}>{LABEL[r.action] ?? r.action}</Badge><span className="text-xs tabular-nums text-subtle">{dt(r.at)}</span></div>
            <p className="break-all text-fg-soft">{r.actorEmail}</p>
            {(r.runId || r.detail) && <p className="text-xs text-muted">{r.runId && <Link className="mr-2 font-mono underline" href={`/runs/${r.runId}`}>{r.runId}</Link>}{r.detail}</p>}
          </li>))}</ul>
      </>)}
    </Card>
  );
}

export function Comments({ title, items }: { title: string; items: Array<GhComment & { extra?: ReactNode }> }) {
  return (
    <Card title={title}>
      {items.length === 0 ? <p className="text-sm text-subtle">None yet.</p> : <ol className="space-y-4">{items.map((c) => (
        <li key={c.id} className="flex gap-3">
          <Avatar login={c.user?.login} />
          <div className="min-w-0 flex-1 rounded-lg border border-border bg-bg/40">
            <p className="flex flex-wrap items-center gap-x-2 border-b border-border px-3 py-2 text-xs text-subtle"><span className="font-medium text-fg-soft">{c.user?.login ?? "?"}</span><span>{dt(c.created_at)}</span>{c.path && <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 text-[11px]">{c.path}{c.line ? `:${c.line}` : ""}</code>}{c.extra}</p>
            <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-sans text-sm leading-relaxed text-fg-soft">{c.body}</pre>
          </div>
        </li>
      ))}</ol>}
    </Card>
  );
}

export const ghDate = dt;
export function GhError({ e }: { e: unknown }) {
  return <p role="alert" className="rounded-md border border-danger-border bg-danger-soft p-3 text-sm text-danger">{e instanceof Error ? e.message : String(e)}</p>;
}
