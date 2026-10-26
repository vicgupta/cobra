/** Pure helpers for the dashboard's Recent runs table (formatting, status tones, sorting). No server imports. */

export type RunRow = {
  id: string;
  name: string;
  kind: "agent" | "skill" | "engine" | "workflow" | "legacy";
  status: string;
  startedAt: number;
  endedAt: number | null;
  triggeredBy: string | null;
};

export type SortKey = "id" | "name" | "status" | "startedAt" | "duration" | "triggeredBy";
export type SortDir = "asc" | "desc";
export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "startedAt", dir: "desc" };

/** 8 chars after a short alpha prefix + underscore (run_, skr_, ...); full ID stays in the title and sort. */
export const shortId = (id: string): string => id.replace(/^[A-Za-z]{1,6}_/, "").slice(0, 8);

/** "agent:foo" → foo (agent), "skill:bar" → bar (skill); legacy rows fall back to the title. */
export function runName(workflow: string | null | undefined, title: string): { name: string; kind: RunRow["kind"] } {
  if (!workflow || workflow === "test-run") return { name: title || "Test run", kind: "legacy" };
  const m = /^(agent|skill|engine):(.+)$/.exec(workflow);
  if (m) return { name: m[2], kind: m[1] as RunRow["kind"] };
  return { name: workflow, kind: "workflow" };
}

/** User's name, else the email local-part; null when no trigger was recorded. */
export function triggeredByLabel(name: string | null | undefined, email: string | null | undefined): string | null {
  if (name && name.trim()) return name.trim();
  const e = (email ?? "").trim();
  if (!e || e === "unknown") return null;
  return e.includes("@") ? e.slice(0, e.indexOf("@")) : e;
}

export function relativeTime(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(d / 365)}y ago`;
}

export function durationMs(r: Pick<RunRow, "startedAt" | "endedAt">): number | null {
  return r.endedAt == null || r.endedAt < r.startedAt ? null : r.endedAt - r.startedAt;
}

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return ms < 1000 ? "<1s" : `${total}s`;
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}h ${m}m` : `${m}m ${s}s`;
}

export type StatusTone = "success" | "failure" | "running" | "pending" | "cancelled" | "neutral";

export function statusTone(status: string | null | undefined): StatusTone {
  const s = (status ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (["succeeded", "success", "ok", "completed", "done", "passed"].includes(s)) return "success";
  if (["failed", "failure", "error", "errored", "timedout"].includes(s)) return "failure";
  if (["running", "inprogress", "started", "active"].includes(s)) return "running";
  if (["queued", "pending", "waiting", "scheduled"].includes(s)) return "pending";
  if (["cancelled", "canceled", "aborted", "skipped"].includes(s)) return "cancelled";
  return "neutral";
}

const STATUS_ORDER: Record<StatusTone, number> = { running: 0, pending: 1, failure: 2, cancelled: 3, success: 4, neutral: 5 };

function cmp(a: RunRow, b: RunRow, key: SortKey): number {
  switch (key) {
    case "startedAt": return a.startedAt - b.startedAt;
    case "duration": {
      const x = durationMs(a), y = durationMs(b);
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
      return x - y;
    }
    case "status": return STATUS_ORDER[statusTone(a.status)] - STATUS_ORDER[statusTone(b.status)] || a.status.localeCompare(b.status);
    case "triggeredBy": {
      const x = a.triggeredBy, y = b.triggeredBy;
      if (!x || !y) return !x && !y ? 0 : !x ? 1 : -1;
      return x.localeCompare(y, undefined, { sensitivity: "base" });
    }
    case "name": return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    case "id": return a.id.localeCompare(b.id);
  }
}

/** Stable sort; missing duration / trigger always sort last; ties broken by newest first. */
export function sortRuns(rows: RunRow[], key: SortKey, dir: SortDir): RunRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const missing = (r: RunRow) => (key === "duration" && durationMs(r) == null) || (key === "triggeredBy" && !r.triggeredBy);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const ma = missing(a.r), mb = missing(b.r);
    if (ma !== mb) return ma ? 1 : -1;
    return sign * cmp(a.r, b.r, key) || b.r.startedAt - a.r.startedAt || a.i - b.i;
  }).map((x) => x.r);
}

/** Clicking the active column flips direction; a new column starts at its natural direction. */
export function nextSort(cur: { key: SortKey; dir: SortDir }, key: SortKey): { key: SortKey; dir: SortDir } {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "startedAt" || key === "duration" ? "desc" : "asc" };
}

export const ariaSort = (cur: { key: SortKey; dir: SortDir }, key: SortKey): "ascending" | "descending" | "none" =>
  cur.key !== key ? "none" : cur.dir === "asc" ? "ascending" : "descending";
