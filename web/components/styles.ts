// Shared Repos-section class tokens (from the issues/PR redesign, a147f07) for Settings and Providers.
// Plain strings so both server and client components can use them.
export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
export const inputCls = "w-full min-h-10 rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm leading-relaxed placeholder:text-faint transition-colors focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60";
export const selectCls = "min-h-10 rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm transition-colors focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60";
export const primaryBtn = `inline-flex min-h-10 items-center justify-center rounded-lg bg-accent-solid px-4 py-2 text-sm font-medium text-on-accent shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
export const ghostBtn = `inline-flex min-h-9 items-center justify-center rounded-lg border border-border-strong px-3 text-sm font-medium text-fg-soft transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
export const subtleDangerBtn = `inline-flex min-h-9 items-center justify-center rounded-lg px-3 text-sm font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-50 ${focusRing}`;
export const dangerBtn = `inline-flex min-h-9 items-center justify-center rounded-lg bg-red-600 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-red-700 disabled:opacity-50 ${focusRing}`;
export const fieldLabel = "mb-1.5 block text-xs font-medium text-fg-soft";
export const sectionTitle = "text-sm font-semibold text-fg";
/** Table chrome used inside a bordered card (header row tinted, uppercase small caps). */
export const tableWrap = "overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm";
export const tableCls = "w-full text-left text-sm";
export const theadCls = "border-b border-border bg-surface-2/50";
export const th = "px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-subtle";
export const td = "px-4 py-3 align-top";
export const okText = "text-sm text-success";
export const errText = "text-sm text-danger";
