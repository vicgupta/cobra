import { test } from "node:test";
import assert from "node:assert/strict";
import { ariaSort, DEFAULT_SORT, formatDuration, nextSort, relativeTime, runName, shortId, sortRuns, statusTone, triggeredByLabel, type RunRow } from "../lib/runs-table";

const row = (id: string, o: Partial<RunRow> = {}): RunRow => ({ id, name: id, kind: "agent", status: "succeeded", startedAt: 0, endedAt: null, triggeredBy: null, ...o });

test("formatting helpers", () => {
  assert.equal(shortId("run_mvpsjba63c3f"), "run_mvps");
  assert.equal(formatDuration(134_000), "2m 14s");
  assert.equal(formatDuration(9_400), "9s");
  assert.equal(formatDuration(400), "<1s");
  assert.equal(formatDuration(3_725_000), "1h 2m");
  assert.equal(formatDuration(null), "—");
  const now = 10_000_000_000;
  assert.equal(relativeTime(now - 10_000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
});

test("names, triggers and status tones", () => {
  assert.deepEqual(runName("agent:tinyagent-merge-pr", "x"), { name: "tinyagent-merge-pr", kind: "agent" });
  assert.deepEqual(runName("skill:Ship", "x"), { name: "Ship", kind: "skill" });
  assert.deepEqual(runName(null, "Issue #1"), { name: "Issue #1", kind: "legacy" });
  assert.equal(triggeredByLabel("Vic Gupta", "v@x.com"), "Vic Gupta");
  assert.equal(triggeredByLabel("", "vic.g@example.com"), "vic.g");
  assert.equal(triggeredByLabel(null, "unknown"), null);
  assert.equal(triggeredByLabel(null, null), null);
  assert.equal(statusTone("succeeded"), "success");
  assert.equal(statusTone("failed"), "failure");
  assert.equal(statusTone("in_progress"), "running");
  assert.equal(statusTone("queued"), "pending");
  assert.equal(statusTone("canceled"), "cancelled");
  assert.equal(statusTone("weird"), "neutral");
  assert.equal(statusTone(null), "neutral");
});

test("sorting: default newest first, every column both ways, blanks last", () => {
  const rows = [
    row("b", { name: "beta", startedAt: 100, endedAt: 400, status: "failed", triggeredBy: "zed" }),
    row("a", { name: "Alpha", startedAt: 300, endedAt: null, status: "running" }),
    row("c", { name: "gamma", startedAt: 200, endedAt: 250, status: "succeeded", triggeredBy: "amy" }),
  ];
  const ids = (k: Parameters<typeof sortRuns>[1], d: "asc" | "desc") => sortRuns(rows, k, d).map((r) => r.id).join("");
  assert.deepEqual(DEFAULT_SORT, { key: "startedAt", dir: "desc" });
  assert.equal(ids("startedAt", "desc"), "acb");
  assert.equal(ids("startedAt", "asc"), "bca");
  assert.equal(ids("name", "asc"), "abc");
  assert.equal(ids("name", "desc"), "cba");
  assert.equal(ids("id", "asc"), "abc");
  assert.equal(ids("duration", "asc"), "cba");
  assert.equal(ids("duration", "desc"), "bca");
  assert.equal(ids("triggeredBy", "asc"), "cba");
  assert.equal(ids("triggeredBy", "desc"), "bca");
  assert.equal(ids("status", "asc"), "abc");
  assert.equal(ids("status", "desc"), "cba");
  assert.equal(rows[0].id, "b", "input not mutated");
});

test("header click cycles and aria-sort", () => {
  assert.deepEqual(nextSort(DEFAULT_SORT, "startedAt"), { key: "startedAt", dir: "asc" });
  assert.deepEqual(nextSort(DEFAULT_SORT, "name"), { key: "name", dir: "asc" });
  assert.deepEqual(nextSort({ key: "name", dir: "asc" }, "name"), { key: "name", dir: "desc" });
  assert.equal(ariaSort(DEFAULT_SORT, "startedAt"), "descending");
  assert.equal(ariaSort(DEFAULT_SORT, "name"), "none");
});
