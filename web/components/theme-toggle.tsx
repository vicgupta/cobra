"use client";

import { useEffect, useSyncExternalStore } from "react";
import { parseTheme, THEMES, themeCookieString, type Theme } from "@/lib/theme";

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onMq = () => { if (current() === "system") apply("system"); };
  mq.addEventListener("change", onMq);
  return () => { listeners.delete(cb); mq.removeEventListener("change", onMq); };
};
const current = (): Theme => parseTheme(document.documentElement.dataset.theme) ?? "system";

function apply(t: Theme) {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.classList.add(dark ? "dark" : "light");
  el.dataset.theme = t;
  document.cookie = themeCookieString(t);
  listeners.forEach((l) => l());
}

const LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
// Icon-only (Job 7): sun / moon / monitor; the label is the tooltip (title) and aria-label.
const svg = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const ICON: Record<Theme, React.ReactNode> = {
  light: <svg {...svg}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>,
  dark: <svg {...svg}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>,
  system: <svg {...svg}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>,
};

/** Light / Dark / System picker in the header. savedTheme: the signed-in user's stored preference (wins). */
export function ThemeToggle({ signedIn, savedTheme }: { signedIn?: boolean; savedTheme?: Theme | null }) {
  const theme = useSyncExternalStore(subscribe, current, () => null);
  useEffect(() => {
    if (savedTheme && savedTheme !== current()) apply(savedTheme);
  }, [savedTheme]);
  const pick = (t: Theme) => {
    apply(t);
    if (signedIn) void fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: t }) }).catch(() => {});
  };
  return (
    <div role="radiogroup" aria-label="Theme" data-theme-toggle className="flex items-center rounded-md border border-border p-0.5 text-xs">
      {THEMES.map((t) => (
        <button key={t} type="button" role="radio" aria-checked={theme === t} title={LABEL[t]} aria-label={`${LABEL[t]} theme`} onClick={() => pick(t)}
          className={`flex items-center rounded px-1.5 py-1 transition ${theme === t ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
          {ICON[t]}
        </button>
      ))}
    </div>
  );
}
