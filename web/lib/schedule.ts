// Friendly schedule presets <-> 5-field cron (America/New_York), and a plain-English preview.
// Pure (no server imports): used by the Tasks form and list, and by tests.
import { parseCron } from "./cron";

export type Preset = "none" | "hourly" | "daily" | "weekdays" | "weekly" | "custom";
export type Schedule = { preset: Preset; time: string; minute: number; day: number; cron: string };
export const PRESETS: Array<[Preset, string]> = [
  ["none", "Not scheduled"], ["hourly", "Every hour"], ["daily", "Every day"], ["weekdays", "Weekdays (Mon–Fri)"], ["weekly", "Once a week"], ["custom", "Custom (cron)"],
];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DEFAULT_SCHEDULE: Schedule = { preset: "none", time: "09:00", minute: 0, day: 1, cron: "" };

const hm = (time: string): [number, number] | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h <= 23 && min <= 59 ? [h, min] : null;
};
const pad = (n: number) => String(n).padStart(2, "0");

/** The cron for a schedule, "" for Not scheduled, or null when a field is invalid. */
export function toCron(s: Schedule): string | null {
  if (s.preset === "none") return "";
  if (s.preset === "custom") return s.cron.trim().replace(/\s+/g, " ");
  if (s.preset === "hourly") return Number.isInteger(s.minute) && s.minute >= 0 && s.minute <= 59 ? `${s.minute} * * * *` : null;
  const t = hm(s.time);
  if (!t) return null;
  const [h, m] = t;
  if (s.preset === "daily") return `${m} ${h} * * *`;
  if (s.preset === "weekdays") return `${m} ${h} * * 1-5`;
  return Number.isInteger(s.day) && s.day >= 0 && s.day <= 6 ? `${m} ${h} * * ${s.day}` : null;
}

/** Recognize a stored cron as a preset; anything else is Custom. */
export function fromCron(cron: string | null | undefined): Schedule {
  const c = (cron ?? "").trim().replace(/\s+/g, " ");
  if (!c) return { ...DEFAULT_SCHEDULE };
  const num = (x: string, hi: number) => (/^\d{1,2}$/.test(x) && Number(x) <= hi ? Number(x) : null);
  const [mi, ho, dom, mon, dow, extra] = c.split(" ");
  if (extra === undefined && dom === "*" && mon === "*") {
    const m = num(mi, 59), h = ho === undefined ? null : num(ho, 23);
    if (m !== null && ho === "*" && dow === "*") return { ...DEFAULT_SCHEDULE, preset: "hourly", minute: m, cron: c };
    if (m !== null && h !== null) {
      const time = `${pad(h)}:${pad(m)}`;
      if (dow === "*") return { ...DEFAULT_SCHEDULE, preset: "daily", time, cron: c };
      if (dow === "1-5") return { ...DEFAULT_SCHEDULE, preset: "weekdays", time, cron: c };
      const d = num(dow ?? "", 7);
      if (d !== null) return { ...DEFAULT_SCHEDULE, preset: "weekly", time, day: d % 7, cron: c };
    }
  }
  return { ...DEFAULT_SCHEDULE, preset: "custom", cron: c };
}

/** "9:00 AM" from hour/minute. */
export function clock(h: number, m: number) {
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** Plain-English preview, e.g. "Runs weekdays at 9:00 AM ET". */
export function describeCron(cron: string | null | undefined): string {
  const c = (cron ?? "").trim();
  if (!c) return "Not scheduled";
  try { parseCron(c); } catch { return "Schedule isn't valid"; }
  const s = fromCron(c);
  const t = hm(s.time), at = t ? clock(t[0], t[1]) : "";
  if (s.preset === "hourly") return s.minute === 0 ? "Runs every hour, on the hour" : `Runs every hour at :${pad(s.minute)}`;
  if (s.preset === "daily") return `Runs every day at ${at} ET`;
  if (s.preset === "weekdays") return `Runs weekdays at ${at} ET`;
  if (s.preset === "weekly") return `Runs every ${DAYS[s.day]} at ${at} ET`;
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(c);
  if (every) return `Runs every ${every[1]} minutes`;
  return `Runs on a custom schedule (${c}, ET)`;
}

/** Plain-words problem with a schedule, or null when it's fine. */
export function scheduleProblem(s: Schedule): string | null {
  if (s.preset === "none") return null;
  if (s.preset === "custom") {
    if (!s.cron.trim()) return "Enter a cron schedule, e.g. 0 9 * * 1-5";
    try { parseCron(s.cron); return null; } catch (e) { return `That cron isn't valid: ${(e as Error).message}`; }
  }
  if (s.preset === "hourly") return toCron(s) === null ? "Pick a minute from 0 to 59" : null;
  return toCron(s) === null ? "Pick a time" : null;
}
