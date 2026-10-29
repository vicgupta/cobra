// Team lessons: per-team, per-repo storage, permissions, review actions, feedback and audit.
// Visibility mirrors skills (lib/skills/store.ts scope()): every query is filtered by the caller's own
// tenant_id, system admins included, so no team ever sees another team's lessons. Every lesson belongs to
// exactly one team repo (repo_id -> team_repos.id, same tenant). Review (approve / edit / reject / retire /
// re-open): team leads, the designated lead and system admins of that team. Members view and add feedback.
import type { DB } from "../db";
import { designatedLead, isSystemAdmin } from "../collab";
import { CAPS, clean, cleanTags, confidenceLabel, parseConfidence } from "./text";

export type Actor = { id: number; email: string; role: "admin" | "team_lead" | "member"; tenantId: number };
export const STATUSES = ["pending", "approved", "rejected", "retired", "stale"] as const;
export type Status = (typeof STATUSES)[number];
export type Flag = { kind: "duplicate" | "sensitive" | "low_confidence" | "stale"; detail: string };
export type Lesson = {
  id: number; tenantId: number; repoId: number; repo: string; status: Status; title: string; whatHappened: string; whatWeLearned: string;
  tags: string[]; confidence: number; confidenceLabel: string; kind: string; signature: string | null; stepId: string | null;
  sourceRunIds: string[]; evidence: string; flags: Flag[]; staleReason: string | null; staleRunId: string | null;
  createdBy: string; createdAt: number; updatedAt: number; approvedBy: string | null; approvedAt: number | null;
  retiredReason: string | null; version: number; supersedesId: number | null;
};
export class LessonError extends Error { constructor(public status: number, msg: string) { super(msg); } }

type Row = Record<string, unknown> & { id: number; tenant_id: number; repo_id: number; repo: string; status: Status; tags: string; source_run_ids: string; flags_json: string; confidence: number };
const fromRow = (r: Row): Lesson => ({
  id: r.id, tenantId: r.tenant_id, repoId: r.repo_id, repo: r.repo, status: r.status, title: r.title as string, whatHappened: r.what_happened as string, whatWeLearned: r.what_we_learned as string,
  tags: JSON.parse(r.tags), confidence: r.confidence, confidenceLabel: confidenceLabel(r.confidence), kind: r.kind as string, signature: (r.signature as string) ?? null, stepId: (r.step_id as string) ?? null,
  sourceRunIds: JSON.parse(r.source_run_ids), evidence: r.evidence as string, flags: JSON.parse(r.flags_json), staleReason: (r.stale_reason as string) ?? null, staleRunId: (r.stale_run_id as string) ?? null,
  createdBy: r.created_by as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number, approvedBy: (r.approved_by as string) ?? null, approvedAt: (r.approved_at as number) ?? null,
  retiredReason: (r.retired_reason as string) ?? null, version: r.version as number, supersedesId: (r.supersedes_id as number) ?? null,
});
const SELECT = "SELECT l.*, r.repo FROM lessons l JOIN team_repos r ON r.id = l.repo_id AND r.tenant_id = l.tenant_id";

/** The team repo id for a repo name (case-insensitive), only within tenantId. */
export function repoIdFor(db: DB, tenantId: number, repo: string | null | undefined): number | null {
  if (!repo) return null;
  const r = db.prepare("SELECT id FROM team_repos WHERE tenant_id = ? AND lower(repo) = lower(?)").get(tenantId, repo) as { id: number } | undefined;
  return r?.id ?? null;
}

export function lessonAudit(db: DB, tenantId: number, lessonId: number | null, actor: string, action: string, detail = "", now = Date.now()) {
  db.prepare("INSERT INTO lesson_audit (tenant_id, lesson_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(tenantId, lessonId, actor, action, detail.slice(0, 500), now);
}
export function listAudit(db: DB, u: Pick<Actor, "tenantId">, lessonId: number) {
  return db.prepare("SELECT actor, action, detail, at FROM lesson_audit WHERE tenant_id = ? AND lesson_id = ? ORDER BY at, id").all(u.tenantId, lessonId) as Array<{ actor: string; action: string; detail: string; at: number }>;
}

export function canReview(db: DB, u: Actor, tenantId = u.tenantId): boolean {
  if (u.tenantId !== tenantId) return false;
  const role = (db.prepare("SELECT role FROM users WHERE id = ? AND tenant_id = ?").get(u.id, tenantId) as { role: string } | undefined)?.role;
  if (!role) return false;
  return isSystemAdmin({ role }) || role === "team_lead" || designatedLead(db, tenantId)?.id === u.id;
}

export type ListFilter = { status?: Status | "history" | "queue" | "all"; repo?: string };
/** The caller's own team only. queue = pending + stale; history = approved + retired + rejected. */
export function listLessons(db: DB, u: Pick<Actor, "tenantId">, f: ListFilter = {}): Lesson[] {
  const st = f.status ?? "all";
  const statuses: readonly string[] = st === "queue" ? ["pending", "stale"] : st === "history" ? ["approved", "retired", "rejected"] : st === "all" ? STATUSES : [st];
  const rows = db.prepare(`${SELECT} WHERE l.tenant_id = ? ORDER BY r.repo, CASE l.status WHEN 'stale' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, l.updated_at DESC, l.id DESC`).all(u.tenantId) as Row[];
  return rows.map(fromRow).filter((l) => statuses.includes(l.status) && (!f.repo || l.repo.toLowerCase() === f.repo.toLowerCase()));
}

/** null when not in the caller's team (404, never 403, so ids can't be probed). */
export function getLesson(db: DB, u: Pick<Actor, "tenantId">, id: number): Lesson | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const r = db.prepare(`${SELECT} WHERE l.id = ? AND l.tenant_id = ?`).get(id, u.tenantId) as Row | undefined;
  return r ? fromRow(r) : null;
}

export type Fields = { title?: unknown; whatHappened?: unknown; whatWeLearned?: unknown; repo?: unknown; tags?: unknown; confidence?: unknown };
/** Validated, cleaned (capped, scrubbed) fields. Throws 400 on missing/invalid values. */
export function cleanFields(db: DB, tenantId: number, f: Fields, partial: boolean, secrets: Iterable<string> = []) {
  const out: { title?: string; what_happened?: string; what_we_learned?: string; repo_id?: number; tags?: string; confidence?: number } = {};
  const text = (k: keyof Fields, col: "title" | "what_happened" | "what_we_learned", cap: number) => {
    if (f[k] === undefined) { if (!partial) throw new LessonError(400, `${col.replace(/_/g, " ")} is required`); return; }
    const v = clean(f[k], cap, secrets);
    if (!v) throw new LessonError(400, `${col.replace(/_/g, " ")} is required`);
    out[col] = v;
  };
  text("title", "title", CAPS.title); text("whatHappened", "what_happened", CAPS.what_happened); text("whatWeLearned", "what_we_learned", CAPS.what_we_learned);
  if (f.repo !== undefined || !partial) {
    const id = typeof f.repo === "string" ? repoIdFor(db, tenantId, f.repo.trim()) : null;
    if (!id) throw new LessonError(400, "repo must be one of your team's repos");
    out.repo_id = id;
  }
  if (f.tags !== undefined) out.tags = JSON.stringify(cleanTags(f.tags));
  if (f.confidence !== undefined) { const c = parseConfidence(f.confidence); if (c === null) throw new LessonError(400, "confidence must be low, medium, high or 0-1"); out.confidence = c; }
  return out;
}

function need(db: DB, u: Actor, id: number): Lesson {
  const l = getLesson(db, u, id);
  if (!l) throw new LessonError(404, "lesson not found");
  if (!canReview(db, u, l.tenantId)) throw new LessonError(403, "only team leads, the designated lead and admins of this team can review lessons");
  return l;
}

/** A lead adds a lesson by hand (status pending, so it goes through the same review). */
export function createLesson(db: DB, u: Actor, f: Fields, now = Date.now()): Lesson {
  if (!canReview(db, u)) throw new LessonError(403, "only team leads, the designated lead and admins of this team can add lessons");
  const c = cleanFields(db, u.tenantId, f, false);
  const r = db.prepare("INSERT INTO lessons (tenant_id, repo_id, status, title, what_happened, what_we_learned, tags, confidence, kind, created_by, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, 'manual', ?, ?, ?)")
    .run(u.tenantId, c.repo_id!, c.title!, c.what_happened!, c.what_we_learned!, c.tags ?? "[]", c.confidence ?? 0.55, u.email, now, now);
  const id = Number(r.lastInsertRowid);
  lessonAudit(db, u.tenantId, id, u.email, "create", "", now);
  return getLesson(db, u, id)!;
}

export function editLesson(db: DB, u: Actor, id: number, f: Fields, now = Date.now()): Lesson {
  const l = need(db, u, id);
  const c = cleanFields(db, u.tenantId, f, true);
  const cols = Object.keys(c) as Array<keyof typeof c>;
  if (!cols.length) return l;
  db.prepare(`UPDATE lessons SET ${cols.map((k) => `${k} = ?`).join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND tenant_id = ?`).run(...cols.map((k) => c[k]!), now, id, u.tenantId);
  lessonAudit(db, u.tenantId, id, u.email, "edit", cols.join(", "), now);
  return getLesson(db, u, id)!;
}

export type Action = "approve" | "reject" | "retire" | "reopen";
const ALLOWED: Record<Action, Status[]> = { approve: ["pending", "stale", "rejected"], reject: ["pending", "stale"], retire: ["approved", "stale", "pending"], reopen: ["retired", "rejected"] };
export function reviewLesson(db: DB, u: Actor, id: number, action: unknown, reason?: unknown, now = Date.now()): Lesson {
  if (action !== "approve" && action !== "reject" && action !== "retire" && action !== "reopen") throw new LessonError(400, "action must be approve, reject, retire or reopen");
  const l = need(db, u, id);
  if (!ALLOWED[action].includes(l.status)) throw new LessonError(409, `can't ${action} a ${l.status} lesson`);
  const why = clean(reason, CAPS.reason);
  if (action === "approve") db.prepare("UPDATE lessons SET status = 'approved', approved_by = ?, approved_at = ?, stale_reason = NULL, stale_run_id = NULL, flags_json = '[]', updated_at = ? WHERE id = ? AND tenant_id = ?").run(u.email, now, now, id, u.tenantId);
  else if (action === "reject") db.prepare("UPDATE lessons SET status = 'rejected', updated_at = ? WHERE id = ? AND tenant_id = ?").run(now, id, u.tenantId);
  else if (action === "retire") db.prepare("UPDATE lessons SET status = 'retired', retired_reason = ?, updated_at = ? WHERE id = ? AND tenant_id = ?").run(why || null, now, id, u.tenantId);
  else db.prepare("UPDATE lessons SET status = 'pending', updated_at = ? WHERE id = ? AND tenant_id = ?").run(now, id, u.tenantId);
  lessonAudit(db, u.tenantId, id, u.email, action, why, now);
  return getLesson(db, u, id)!;
}

/** Any member of the lesson's team may comment / correct. */
export function addFeedback(db: DB, u: Actor, id: number, text: unknown, now = Date.now()) {
  const l = getLesson(db, u, id);
  if (!l) throw new LessonError(404, "lesson not found");
  const t = clean(text, CAPS.feedback);
  if (!t) throw new LessonError(400, "feedback text is required");
  db.prepare("INSERT INTO lesson_feedback (lesson_id, tenant_id, author, text, at) VALUES (?, ?, ?, ?, ?)").run(id, u.tenantId, u.email, t, now);
  lessonAudit(db, u.tenantId, id, u.email, "feedback", "", now);
  return listFeedback(db, u, id);
}
export function listFeedback(db: DB, u: Pick<Actor, "tenantId">, id: number) {
  return db.prepare("SELECT author, text, at FROM lesson_feedback WHERE lesson_id = ? AND tenant_id = ? ORDER BY at, id").all(id, u.tenantId).map((r) => ({ ...r })) as Array<{ author: string; text: string; at: number }>;
}
