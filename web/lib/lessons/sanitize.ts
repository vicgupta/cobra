// Weekly sanitization pass (per team, per repo): flags pending/approved lessons for the team lead as badges
// in the review queue. Flags: duplicate (near-duplicate of another lesson in the same repo), sensitive
// (secret- or PII-looking text left after redaction), low_confidence (< 0.35), stale (no run in that repo
// for STALE_DAYS). Flags only; it never changes a lesson's status.
import type { DB } from "../db";
import { lessonAudit, type Flag } from "./store";
import { keywords, looksSensitive } from "./text";

export const STALE_DAYS = 30;
const DAY = 86_400_000;
const jaccard = (a: string[], b: string[]) => { const A = new Set(a), B = new Set(b); const i = [...A].filter((x) => B.has(x)).length; return A.size + B.size - i ? i / (A.size + B.size - i) : 0; };

type Row = { id: number; repo_id: number; repo: string; title: string; what_happened: string; what_we_learned: string; evidence: string; confidence: number; flags_json: string };
export function sanitizeTeam(db: DB, tenantId: number, now = Date.now()): { flagged: number } {
  const rows = db.prepare("SELECT l.id, l.repo_id, r.repo, l.title, l.what_happened, l.what_we_learned, l.evidence, l.confidence, l.flags_json FROM lessons l JOIN team_repos r ON r.id = l.repo_id AND r.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND l.status IN ('pending','approved') ORDER BY l.id").all(tenantId) as Row[];
  const words = new Map(rows.map((l) => [l.id, keywords(`${l.title} ${l.what_happened} ${l.what_we_learned}`)]));
  let flagged = 0;
  for (const l of rows) {
    const flags: Flag[] = [];
    const dup = rows.find((o) => o.id !== l.id && o.repo_id === l.repo_id && jaccard(words.get(l.id)!, words.get(o.id)!) >= 0.6);
    if (dup) flags.push({ kind: "duplicate", detail: `Similar to lesson #${dup.id}` });
    if (looksSensitive(`${l.title} ${l.what_happened} ${l.what_we_learned} ${l.evidence}`)) flags.push({ kind: "sensitive", detail: "May contain a secret or personal data" });
    if (l.confidence < 0.35) flags.push({ kind: "low_confidence", detail: `Confidence ${l.confidence.toFixed(2)}` });
    const last = (db.prepare("SELECT max(started_at) t FROM runs WHERE tenant_id = ? AND lower(repo) = lower(?)").get(tenantId, l.repo) as { t: number | null }).t;
    if (!last || now - last > STALE_DAYS * DAY) flags.push({ kind: "stale", detail: `No run in ${l.repo} for ${STALE_DAYS}+ days` });
    const json = JSON.stringify(flags);
    if (json !== l.flags_json) {
      db.prepare("UPDATE lessons SET flags_json = ? WHERE id = ? AND tenant_id = ?").run(json, l.id, tenantId);
      if (flags.length) lessonAudit(db, tenantId, l.id, "system", "sanitize", flags.map((f) => f.kind).join(", "), now);
    }
    if (flags.length) flagged++;
  }
  return { flagged };
}
