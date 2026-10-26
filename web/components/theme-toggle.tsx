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
const ICON: Record<Theme, string> = { light: "☀", dark: "☾", system: "◐" };

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
        <button key={t} type="button" role="radio" aria-checked={theme === t} title={`${LABEL[t]} theme`} onClick={() => pick(t)}
          className={`rounded px-2 py-1 transition ${theme === t ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
          <span aria-hidden>{ICON[t]}</span><span className="ml-1 hidden md:inline">{LABEL[t]}</span>
        </button>
      ))}
    </div>
  );
}
