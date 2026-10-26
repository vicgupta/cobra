// Light / Dark / System theme preference. Pure helpers shared by server, client and tests.
// Stored per browser in the `cobra_theme` cookie (read by the inline pre-paint script) and
// per signed-in user in users.theme (NULL = never chosen). See docs/workflow-redesign.md "Theming".
export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "cobra_theme";
export const THEME_COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // seconds (browser max)

export function parseTheme(v: unknown): Theme | null {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v) ? (v as Theme) : null;
}

/** The signed-in user's saved preference wins over the browser cookie; default is system. */
export function effectiveTheme(userTheme: string | null | undefined, cookieTheme: string | null | undefined): Theme {
  return parseTheme(userTheme) ?? parseTheme(cookieTheme) ?? "system";
}

export const nextTheme = (t: Theme): Theme => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];

export const themeCookieString = (t: Theme) => `${THEME_COOKIE}=${t}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;

/**
 * Runs in <head> before first paint: reads the cookie, resolves "system" with
 * prefers-color-scheme and sets <html class="dark|light" data-theme="...">. No flash.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark|system)/);var t=m?m[1]:"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.classList.remove("light","dark");e.classList.add(d?"dark":"light");e.dataset.theme=t;}catch(_){}})();`;

/** Job 7b single toggle: what clicking switches to, given the resolved (painted) theme. Never "system". */
export const toggleTarget = (resolvedDark: boolean): "light" | "dark" => (resolvedDark ? "light" : "dark");
/** The toggle's label/tooltip: it names the theme a click switches to. */
export const toggleLabel = (resolvedDark: boolean) => (resolvedDark ? { title: "Light", aria: "Switch to light theme" } : { title: "Dark", aria: "Switch to dark theme" });
