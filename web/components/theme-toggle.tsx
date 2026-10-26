"use client";

// Job 7b: one icon button. Dark painted: sun ("Light"); light painted: moon ("Dark"). No system icon.
// With no saved choice the theme stays "system" (prefers-color-scheme, resolved before paint by
// THEME_INIT_SCRIPT); the first click saves an explicit light/dark.
import { useEffect, useSyncExternalStore } from "react";
import { parseTheme, themeCookieString, toggleLabel, toggleTarget, type Theme } from "@/lib/theme";

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onMq = () => { if (saved() === "system") apply("system"); };
  mq.addEventListener("change", onMq);
  return () => { listeners.delete(cb); mq.removeEventListener("change", onMq); };
};
const saved = (): Theme => parseTheme(document.documentElement.dataset.theme) ?? "system";
const isDark = () => document.documentElement.classList.contains("dark");

function apply(t: Theme) {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.classList.add(dark ? "dark" : "light");
  el.dataset.theme = t;
  if (t !== "system") document.cookie = themeCookieString(t);
  listeners.forEach((l) => l());
}

const svg = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const Sun = () => <svg {...svg} data-icon="sun"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>;
const Moon = () => <svg {...svg} data-icon="moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>;

/** savedTheme: the signed-in user's stored preference (wins over the cookie). */
export function ThemeToggle({ signedIn, savedTheme }: { signedIn?: boolean; savedTheme?: Theme | null }) {
  // Server snapshot null: the server renders an empty placeholder of the same size, so no hydration mismatch.
  const dark = useSyncExternalStore(subscribe, isDark, () => null);
  useEffect(() => {
    if (savedTheme && savedTheme !== saved()) apply(savedTheme);
  }, [savedTheme]);
  const cls = "flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted transition hover:bg-surface-2 hover:text-fg";
  if (dark === null) return <span data-theme-toggle aria-hidden className={cls} />;
  const l = toggleLabel(dark);
  const pick = () => {
    const t = toggleTarget(dark);
    apply(t);
    if (signedIn) void fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: t }) }).catch(() => {});
  };
  return (
    <button type="button" data-theme-toggle title={l.title} aria-label={l.aria} onClick={pick} className={cls}>
      {dark ? <Sun /> : <Moon />}
    </button>
  );
}
