// Minimal 5-field cron (minute hour day-of-month month day-of-week), evaluated in America/New_York.
// Supports *, lists (1,2), ranges (1-5), steps (*/15, 0-30/10) and day-of-week 0-7 (0 and 7 = Sunday).
// Standard rule: when both day-of-month and day-of-week are restricted, either may match.
export const CRON_TZ = "America/New_York";

export type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean };

const FIELDS: Array<[string, number, number]> = [["minute", 0, 59], ["hour", 0, 23], ["day of month", 1, 31], ["month", 1, 12], ["day of week", 0, 7]];

function field(src: string, [label, lo, hi]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid ${label} '${part}'`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let a = lo, b = hi;
    if (m[1] !== "*") { a = Number(m[2]); b = m[3] === undefined ? (m[4] === undefined ? a : hi) : Number(m[3]); }
    if (a < lo || b > hi || a > b) throw new Error(`${label} must be ${lo}-${hi}`);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid ${label} step '${m[4]}'`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("use 5 fields: minute hour day-of-month month day-of-week (e.g. '0 9 * * 1-5')");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]));
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: CRON_TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in America/New_York. */
export function etParts(ms: number) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), dow: DAYS[p.weekday] };
}

export function cronMatches(c: Cron, ms: number): boolean {
  const t = etParts(ms);
  if (!c.minute.has(t.minute) || !c.hour.has(t.hour) || !c.month.has(t.month)) return false;
  const d = c.dom.has(t.day), w = c.dow.has(t.dow);
  return c.domAny && c.dowAny ? true : c.domAny ? w : c.dowAny ? d : d || w;
}

export const minuteFloor = (ms: number) => Math.floor(ms / 60_000) * 60_000;

/** The next matching minute after `from` (searches up to ~1 year); null if none. */
export function nextFire(c: Cron, from: number): number | null {
  let t = minuteFloor(from) + 60_000;
  for (let i = 0; i < 366 * 24 * 60; i++, t += 60_000) if (cronMatches(c, t)) return t;
  return null;
}
