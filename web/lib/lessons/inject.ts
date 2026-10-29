// Injection: before an agent/skill run starts, pick the team's APPROVED lessons for the run's exact repo
// (same team, same repo; nothing else is ever eligible), rank by keyword/tag overlap with the task text,
// agent and skill name (ties: confidence, then newest), keep the top K whose block fits under the char cap,
// and prepend one delimited "Team lessons" block to the prompt. No repo -> nothing injected.
import type { DB } from "../db";
import { repoIdFor } from "./store";
import { keywords } from "./text";

export const DEFAULT_K = 5, DEFAULT_CAP = 4000;
const envInt = (n: string, d: number) => { const v = Number(process.env[n]); return Number.isInteger(v) && v > 0 ? v : d; };
export const injectionLimits = () => ({ k: envInt("COBRA_LESSONS_INJECT_K", DEFAULT_K), cap: envInt("COBRA_LESSONS_INJECT_CHARS", DEFAULT_CAP), enabled: process.env.COBRA_LESSONS_INJECT !== "off" });

export const BLOCK_START = "=== Team lessons (approved by your team for this repo; follow unless the task says otherwise) ===";
export const BLOCK_END = "=== End team lessons ===";

type Row = { id: number; title: string; what_happened: string; what_we_learned: string; tags: string; confidence: number; updated_at: number };
export type Picked = { ids: number[]; block: string };

export const lessonLine = (l: Pick<Row, "id" | "title" | "what_happened" | "what_we_learned">) => `- [L${l.id}] ${l.title}. Happened: ${l.what_happened} Learned: ${l.what_we_learned}`;

export function selectLessons(db: DB, tenantId: number, repo: string | null | undefined, task: string, o: { k?: number; cap?: number } = {}): Picked {
  const lim = injectionLimits();
  if (!lim.enabled) return { ids: [], block: "" };
  const k = o.k ?? lim.k, cap = o.cap ?? lim.cap;
  const repoId = repoIdFor(db, tenantId, repo);
  if (!repoId || k <= 0) return { ids: [], block: "" };
  const rows = db.prepare("SELECT id, title, what_happened, what_we_learned, tags, confidence, updated_at FROM lessons WHERE tenant_id = ? AND repo_id = ? AND status = 'approved'").all(tenantId, repoId) as Row[];
  const want = new Set(keywords(task));
  const scored = rows.map((l) => {
    const tags: string[] = JSON.parse(l.tags);
    const tagHits = tags.filter((t) => want.has(t) || keywords(t).some((w) => want.has(w))).length;
    const wordHits = keywords(`${l.title} ${l.what_happened} ${l.what_we_learned}`).filter((w) => want.has(w)).length;
    return { l, score: tagHits * 2 + wordHits };
  }).sort((a, b) => b.score - a.score || b.l.confidence - a.l.confidence || b.l.updated_at - a.l.updated_at || b.l.id - a.l.id);
  const lines: string[] = [], ids: number[] = [];
  let size = BLOCK_START.length + BLOCK_END.length + 2;
  for (const { l } of scored) {
    if (ids.length >= k) break;
    const line = lessonLine(l);
    if (size + line.length + 1 > cap) continue;
    lines.push(line); ids.push(l.id); size += line.length + 1;
  }
  return ids.length ? { ids, block: `${BLOCK_START}\n${lines.join("\n")}\n${BLOCK_END}` } : { ids: [], block: "" };
}

/** The prompt with the block prepended (unchanged when nothing is picked). */
export const withLessons = (prompt: string, p: Picked) => (p.block ? `${p.block}\n\n${prompt}` : prompt);

export function recordInjected(db: DB, runId: string, ids: number[]) {
  if (ids.length) db.prepare("UPDATE runs SET injected_lessons = ? WHERE id = ?").run(JSON.stringify(ids), runId);
}

/** Injected lessons for a run (same team only), for the run detail page. */
export function injectedFor(db: DB, tenantId: number, runId: string): Array<{ id: number; title: string; status: string }> {
  const r = db.prepare("SELECT injected_lessons FROM runs WHERE id = ? AND tenant_id = ?").get(runId, tenantId) as { injected_lessons: string | null } | undefined;
  const ids: number[] = r?.injected_lessons ? JSON.parse(r.injected_lessons) : [];
  return ids.map((id) => db.prepare("SELECT id, title, status FROM lessons WHERE id = ? AND tenant_id = ?").get(id, tenantId) as { id: number; title: string; status: string } | undefined)
    .filter((x): x is { id: number; title: string; status: string } => !!x).map((x) => ({ ...x }));
}
