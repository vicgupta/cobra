// Pure helpers for step output (safe to import from client components): head+tail capping with a clear
// marker, merging a step's live stream with its final log, and collapsing the append-only
// run_step_events history (pending -> running -> terminal rows) into one entry per step for display.

export const LOG_CAP = 200_000;

export const truncationMarker = (omitted: number) => `\n… [truncated: ${omitted} chars omitted] …\n`;

/** Keeps the first quarter and the last three quarters of `cap` chars, with a marker in between. */
export function capLog(text: string, cap = LOG_CAP): { text: string; truncated: boolean; omitted: number } {
  if (text.length <= cap) return { text, truncated: false, omitted: 0 };
  const head = Math.floor(cap / 4), tail = cap - head, omitted = text.length - head - tail;
  return { text: text.slice(0, head) + truncationMarker(omitted) + text.slice(-tail), truncated: true, omitted };
}

/** Bounded live buffer: the first quarter of `cap` is kept, then a rolling tail; counts what was dropped. */
export class LiveLog {
  head = ""; tail = ""; omitted = 0;
  constructor(private cap = LOG_CAP) {}
  append(chunk: string) {
    const h = Math.floor(this.cap / 4), t = this.cap - h;
    if (this.head.length < h) { const take = chunk.slice(0, h - this.head.length); this.head += take; chunk = chunk.slice(take.length); }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > t) { this.omitted += this.tail.length - t; this.tail = this.tail.slice(-t); }
  }
  get text() { return this.head + (this.omitted ? truncationMarker(this.omitted) : "") + this.tail; }
  get truncated() { return this.omitted > 0; }
}

/** `a` followed by whatever of `b` isn't a shared prefix (both usually start with the same agent header). */
export function mergeLogs(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b || null;
  if (!b || a === b || a.includes(b)) return a;
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  // Only split at a line boundary, so a coincidental shared character can't eat the start of the next line.
  if (k < b.length && k > 0 && b[k - 1] !== "\n" && b[k] !== "\n") k = b.lastIndexOf("\n", k - 1) + 1;
  const rest = b.slice(k);
  return a + (a.endsWith("\n") || rest.startsWith("\n") ? "" : "\n") + rest;
}

export type StepEvent = { stepId: string; status: string; attempt: number; output: string | null; truncated: boolean; at: number };
export type StepView = StepEvent & { startedAt: number; history: string[] };

/** One entry per step, in first-seen order: the latest status/attempt/time, outputs merged across its rows. */
export function collapseSteps(events: readonly StepEvent[]): StepView[] {
  const by = new Map<string, StepView>();
  for (const e of events) {
    const v = by.get(e.stepId);
    if (!v) { by.set(e.stepId, { ...e, startedAt: e.at, history: [e.status] }); continue; }
    v.status = e.status; v.attempt = e.attempt; v.at = e.at;
    if (v.history[v.history.length - 1] !== e.status) v.history.push(e.status);
    v.output = mergeLogs(v.output, e.output);
    v.truncated = v.truncated || e.truncated;
  }
  return [...by.values()];
}
