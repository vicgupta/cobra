// API-facing lesson operations ({status, body}); every read and write is scoped to the caller's own team.
import type { DB } from "../db";
import { listTeamRepos } from "../repos";
import { addFeedback, canReview, createLesson, editLesson, getLesson, LessonError, listAudit, listFeedback, listLessons, reviewLesson, STATUSES, type Actor, type ListFilter } from "./store";

export type Res = { status: number; body: unknown };
const ok = (body: unknown, status = 200): Res => ({ status, body });
const wrap = (f: () => Res): Res => {
  try { return f(); } catch (e) {
    if (e instanceof LessonError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
};
const parseFilter = (status: unknown, repo: unknown): ListFilter => ({
  status: typeof status === "string" && (["queue", "history", "all", ...STATUSES] as string[]).includes(status) ? (status as ListFilter["status"]) : "all",
  repo: typeof repo === "string" && repo.trim() ? repo.trim() : undefined,
});

export function lessonsView(db: DB, u: Actor, status?: unknown, repo?: unknown) {
  const lessons = listLessons(db, u, parseFilter(status, repo)).map((l) => ({ ...l, feedbackCount: listFeedback(db, u, l.id).length }));
  return { lessons, canReview: canReview(db, u), repos: listTeamRepos(db, u.tenantId).map((r) => r.repo) };
}
export const list = (db: DB, u: Actor, status?: unknown, repo?: unknown): Res => ok(lessonsView(db, u, status, repo));
export const detail = (db: DB, u: Actor, id: unknown): Res => wrap(() => {
  const l = getLesson(db, u, Number(id));
  if (!l) throw new LessonError(404, "lesson not found");
  return ok({ lesson: l, feedback: listFeedback(db, u, l.id), audit: listAudit(db, u, l.id), canReview: canReview(db, u) });
});
type Body = Record<string, unknown> | null;
export const create = (db: DB, u: Actor, b: Body): Res => wrap(() => ok({ lesson: createLesson(db, u, b ?? {}) }, 201));
export const edit = (db: DB, u: Actor, id: unknown, b: Body): Res => wrap(() => ok({ lesson: editLesson(db, u, Number(id), b ?? {}) }));
export const act = (db: DB, u: Actor, id: unknown, b: Body): Res => wrap(() => ok({ lesson: reviewLesson(db, u, Number(id), b?.action, b?.reason) }));
export const feedback = (db: DB, u: Actor, id: unknown, b: Body): Res => wrap(() => ok({ feedback: addFeedback(db, u, Number(id), b?.text) }, 201));
