import { test } from "node:test";
import assert from "node:assert/strict";
import { toCron, fromCron, describeCron, scheduleProblem, DEFAULT_SCHEDULE, clock, PRESETS, FIXED, CRON_HELP } from "../lib/schedule";
import { parseCron } from "../lib/cron";

const s = (o: object) => ({ ...DEFAULT_SCHEDULE, ...o });

test("presets map to cron and back", () => {
  const cases: Array<[object, string]> = [
    [{ preset: "hourly", minute: 15 }, "15 * * * *"],
    [{ preset: "daily", time: "21:30" }, "30 21 * * *"],
    [{ preset: "weekdays", time: "09:00" }, "0 9 * * 1-5"],
    [{ preset: "weekly", time: "09:00", day: 1 }, "0 9 * * 1"],
  ];
  for (const [o, cron] of cases) {
    assert.equal(toCron(s(o) as never), cron);
    const back = fromCron(cron);
    assert.equal(back.preset, (o as { preset: string }).preset);
    assert.equal(toCron(back), cron);
  }
  assert.equal(toCron(s({ preset: "none" }) as never), "");
  assert.equal(fromCron("0 9 * * 7").day, 0);
  assert.equal(fromCron("*/5 * * * *").preset, "custom");
  assert.equal(toCron(s({ preset: "daily", time: "25:00" }) as never), null);
});

test("plain-English preview", () => {
  assert.equal(describeCron(""), "Not scheduled");
  assert.equal(describeCron("0 9 * * 1-5"), "Runs weekdays at 9:00 AM ET");
  assert.equal(describeCron("30 21 * * *"), "Runs every day at 9:30 PM ET");
  assert.equal(describeCron("0 9 * * 1"), "Runs every Monday at 9:00 AM ET");
  assert.equal(describeCron("0 * * * *"), "Runs every hour, on the hour");
  assert.equal(describeCron("15 * * * *"), "Runs every hour at :15");
  assert.equal(describeCron("*/10 * * * *"), "Runs every 10 minutes");
  assert.equal(describeCron("0 9 1 * *"), "Custom schedule (0 9 1 * *, ET)");
  assert.equal(describeCron("nope"), "Schedule isn't valid");
  assert.equal(clock(0, 5), "12:05 AM");
});

test("schedule problems are plain words", () => {
  assert.equal(scheduleProblem(s({ preset: "weekdays" }) as never), null);
  const p = scheduleProblem(s({ preset: "custom", cron: "bad" }) as never);
  assert.ok(p && !/cron parse|NaN|undefined/i.test(p), String(p));
});

test("cron help presets: labels, crons, round-trip and readings", () => {
  const want: Array<[string, string, string, string]> = [
    ["every15", "Every 15 minutes", "*/15 * * * *", "Runs every 15 minutes"],
    ["every30", "Every 30 minutes", "*/30 * * * *", "Runs every 30 minutes"],
    ["hourly", "Every hour", "0 * * * *", "Runs every hour, on the hour"],
    ["every2h", "Every 2 hours", "0 */2 * * *", "Runs every 2 hours, on the hour"],
    ["every4h", "Every 4 hours", "0 */4 * * *", "Runs every 4 hours, on the hour"],
    ["even", "Every even hour", "0 0-22/2 * * *", "Runs every even hour (12 AM, 2 AM … 10 PM ET)"],
    ["odd", "Every odd hour", "0 1-23/2 * * *", "Runs every odd hour (1 AM, 3 AM … 11 PM ET)"],
    ["daily", "Once a day", "0 9 * * *", "Runs every day at 9:00 AM ET"],
    ["weekdays", "Weekdays only", "0 9 * * 1-5", "Runs weekdays at 9:00 AM ET"],
  ];
  const labels = new Map(PRESETS);
  assert.equal(labels.get("custom"), "Custom");
  assert.equal(labels.get("none"), "Not scheduled");
  assert.equal(labels.get("weekly"), "Once a week");
  for (const [p, label, cron, reading] of want) {
    assert.equal(labels.get(p as never), label);
    const filled = toCron(s({ preset: p }) as never); // picking the preset fills this cron (default time 9:00, minute 0)
    assert.equal(filled, cron, p);
    parseCron(cron);
    assert.equal(fromCron(cron).preset, p, `${cron} maps back to ${p}`);
    assert.equal(describeCron(cron), reading);
  }
  // 0 */2 and 0 0-22/2 fire at the same times; each keeps its own preset
  assert.deepEqual([...parseCron(FIXED.every2h!).hour], [...parseCron(FIXED.even!).hour]);
  // existing crons keep working
  assert.equal(fromCron("15 * * * *").preset, "hourly");
  assert.equal(fromCron("0 5 * * *").preset, "daily");
  assert.equal(describeCron("0 5 * * *"), "Runs every day at 5:00 AM ET");
  assert.equal(describeCron("15 */3 * * *"), "Runs every 3 hours, at :15");
  assert.equal(fromCron("15 */3 * * *").preset, "custom");
  assert.match(CRON_HELP, /^A schedule is five values.*Sunday is 0\..*Times are Eastern \(ET\)\.$/);
});
