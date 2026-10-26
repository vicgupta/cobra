// SOP body sections: markdown headings become anchors (GitHub-style slugs, de-duplicated
// with -2, -3 ...). Agent steps reference a section by anchor; the executor passes only that
// section with the step's prompt, and the full body as a workspace file. Linear time.
export type Section = { anchor: string; title: string; level: number; start: number; end: number };

export const slug = (t: string) => t.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "section";

export function sections(body: string): Section[] {
  const lines = body.split("\n"), out: Section[] = [], seen = new Map<string, number>();
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (!m) return;
    const base = slug(m[2]), n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ anchor: n === 1 ? base : `${base}-${n}`, title: m[2], level: m[1].length, start: i, end: lines.length });
  });
  // A section runs until the next heading of the same or higher level.
  const stack: Section[] = [];
  for (const s of out) {
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop()!.end = s.start;
    stack.push(s);
  }
  return out;
}

export function sectionText(body: string, anchor: string, all = sections(body)): string | null {
  const s = all.find((x) => x.anchor === anchor);
  return s ? body.split("\n").slice(s.start, s.end).join("\n").trim() : null;
}
