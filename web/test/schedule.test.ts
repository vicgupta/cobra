import { test } from "node:test";
import assert from "node:assert/strict";
import { toCron, fromCron, describeCron, scheduleProblem, DEFAULT_SCHEDULE, clock } from "../lib/schedule";

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
  assert.match(describeCron("0 9 1 * *"), /custom schedule/);
  assert.equal(describeCron("nope"), "Schedule isn't valid");
  assert.equal(clock(0, 5), "12:05 AM");
});

test("schedule problems are plain words", () => {
  assert.equal(scheduleProblem(s({ preset: "weekdays" }) as never), null);
  const p = scheduleProblem(s({ preset: "custom", cron: "bad" }) as never);
  assert.ok(p && !/cron parse|NaN|undefined/i.test(p), String(p));
});
