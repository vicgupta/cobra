import type { ReactNode } from "react";

export function Card({ title, subtitle, action, children, className = "" }: {
  title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-xl border border-border bg-surface/60 shadow-sm ${className}`}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-subtle">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const tones = {
  gray: "bg-surface-2 text-fg-soft ring-border-strong",
  green: "bg-emerald-500/10 text-success ring-emerald-500/30",
  blue: "bg-sky-500/10 text-info ring-sky-500/30",
  amber: "bg-amber-500/10 text-warning ring-amber-500/30",
  red: "bg-rose-500/10 text-danger ring-rose-500/30",
  violet: "bg-violet-500/10 text-violet ring-violet-500/30",
  orange: "bg-orange-500/10 text-orange ring-orange-500/30",
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = "gray", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface/60 p-4">
      <p className="text-xs uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

export function ExampleDataBanner() {
  return (
    <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-4 py-2 text-xs text-warning">
      Example data — this dashboard shows mock runs, agents and team members from <code>lib/mock-data.ts</code>.
    </div>
  );
}
